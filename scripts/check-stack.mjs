import assert from 'node:assert/strict'
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'

const sidecar = `http://127.0.0.1:${process.env.SPARK_LOCAL_PORT || 8765}`
const lnbits = `http://127.0.0.1:${process.env.LNBITS_LOCAL_PORT || 5100}`
const sidecarHeaders = {'X-Api-Key': process.env.SPARK_SIDECAR_API_KEY}
const stateFile = new URL('../.local/check-stack.json', import.meta.url)

async function request(base, route, {method = 'GET', body, headers = {}} = {}) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {'Content-Type': 'application/json', ...headers},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000)
  })
  assert(res.ok, `${method} ${route}: HTTP ${res.status}`)
  return res.json()
}

async function main() {
  assert(process.env.SPARK_SIDECAR_API_KEY, 'Load .env first')
  const unauthorized = await fetch(`${sidecar}/health`, {
    signal: AbortSignal.timeout(5000)
  })
  assert.equal(unauthorized.status, 401, 'Sidecar must require an API key')
  await request(sidecar, '/health', {headers: sidecarHeaders})
  const balance = await request(sidecar, '/v1/balance', {
    method: 'POST',
    headers: sidecarHeaders,
    body: {}
  })
  assert.equal(balance.status, 'ok', 'Real Spark wallet must be initialized')
  assert.match(balance.balance_sats, /^\d+$/)
  console.log(
    `PASS sidecar authentication and live balance (${balance.balance_sats} sats)`
  )

  const credentials = {
    username: process.env.LNBITS_TEST_USERNAME,
    password: process.env.LNBITS_TEST_PASSWORD
  }
  let login = await fetch(`${lnbits}/api/v1/auth`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(credentials),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000)
  })
  if (!login.ok) {
    await request(lnbits, '/api/v1/auth/first_install', {
      method: 'PUT',
      body: {
        ...credentials,
        password_repeat: credentials.password,
        first_install_token: process.env.FIRST_INSTALL_TOKEN
      }
    })
    login = await fetch(`${lnbits}/api/v1/auth`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(credentials),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000)
    })
  }
  assert(login.ok, `LNbits login: HTTP ${login.status}`)
  const {access_token: token} = await login.json()
  assert(token, 'LNbits must return an access token')
  const auth = {Authorization: `Bearer ${token}`}
  await request(lnbits, '/api/v1/health')
  const settings = await request(lnbits, '/admin/api/v1/settings', {
    headers: auth
  })
  assert.equal(settings.lnbits_backend_wallet_class, 'SparkL2Wallet')
  assert.equal(settings.spark_l2_external_endpoint, 'http://sidecar:8765')
  const audit = await request(lnbits, '/admin/api/v1/audit', {headers: auth})
  assert.equal(
    audit.lnbits_balance_sats,
    audit.node_balance_sats,
    'LNbits total balance must reconcile with Spark'
  )
  console.log(
    `PASS LNbits/Spark accounting (${audit.node_balance_sats} sats each)`
  )

  const wallets = await request(lnbits, '/api/v1/wallet/paginated?limit=100', {
    headers: auth
  })
  const wallet =
    wallets.data.find(w => w.name === 'Spark integration test') ||
    (await request(lnbits, '/api/v1/wallet', {
      method: 'POST',
      headers: auth,
      body: {name: 'Spark integration test'}
    }))
  assert(wallet.adminkey, 'Test wallet must have an admin key')
  const walletHeaders = {'X-Api-Key': wallet.adminkey}
  let saved
  try {
    saved = JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!saved) {
    const invoice = await request(lnbits, '/api/v1/payments', {
      method: 'POST',
      headers: walletHeaders,
      body: {
        out: false,
        amount: 1000,
        memo: 'Spark Compose integration',
        expiry: 86400
      }
    })
    assert(
      invoice.checking_id && invoice.payment_hash && invoice.bolt11,
      'Invoice must include a Spark request ID, payment hash and BOLT11'
    )
    saved = {wallet_id: wallet.id, ...invoice}
    mkdirSync(new URL('../.local/', import.meta.url), {
      recursive: true,
      mode: 0o700
    })
    writeFileSync(stateFile, JSON.stringify(saved, null, 2) + '\n', {
      mode: 0o600
    })
    console.log('PASS LNbits created a real 1000-sat Spark invoice')
  }
  assert.equal(
    saved.wallet_id,
    wallet.id,
    'Saved invoice must belong to this test wallet'
  )
  const receipt = await request(
    sidecar,
    `/v1/invoices/${encodeURIComponent(saved.checking_id)}`,
    {
      headers: sidecarHeaders
    }
  )
  assert.equal(receipt.payment_hash, saved.payment_hash)
  const payment = await request(
    lnbits,
    `/api/v1/payments/${saved.payment_hash}`,
    {
      headers: walletHeaders
    }
  )
  const account = await request(lnbits, '/api/v1/wallet', {
    headers: walletHeaders
  })
  assert.equal(
    typeof payment.paid,
    'boolean',
    'LNbits must return a payment state'
  )
  assert(
    Number.isSafeInteger(account.balance),
    'LNbits balance must be integer msat'
  )
  if (payment.paid) {
    assert(
      [
        'LIGHTNING_PAYMENT_RECEIVED',
        'TRANSFER_COMPLETED',
        'PAYMENT_PREIMAGE_RECOVERED'
      ].includes(receipt.status),
      'A credited LNbits invoice must have a settled Spark receipt'
    )
  }
  console.log(
    `PASS persisted invoice lookup: Spark=${receipt.status}, LNbits paid=${payment.paid}, wallet=${account.balance} msat`
  )

  const streamAbort = new AbortController()
  const streamTimeout = setTimeout(() => streamAbort.abort(), 10_000)
  try {
    const stream = await fetch(`${sidecar}/v1/invoices/stream`, {
      headers: sidecarHeaders,
      signal: streamAbort.signal
    })
    assert.equal(stream.status, 200)
    assert.match(stream.headers.get('content-type'), /text\/event-stream/)
    const first = await stream.body.getReader().read()
    assert(!first.done && first.value.length > 0, 'SSE stream must send data')
    console.log('PASS live SSE connection')
  } finally {
    clearTimeout(streamTimeout)
    streamAbort.abort()
  }
  console.log(`LNbits: ${lnbits} (credentials in .env)`)
  console.log(
    'Invoice saved in .local/check-stack.json; no outgoing payment was sent.'
  )
  if (!payment.paid)
    console.log(
      'Fund this invoice to test settlement, then rerun after a restart.'
    )
}

main().catch(error => {
  console.error(`FAIL ${error.message}`)
  process.exitCode = 1
})
