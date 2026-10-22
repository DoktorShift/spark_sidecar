import {randomBytes} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {generateMnemonic} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english'

const env = [
  '# Dedicated local Spark test wallet. Back up privately before funding.',
  'SPARK_NETWORK=MAINNET',
  `SPARK_MNEMONIC="${generateMnemonic(wordlist, 256)}"`,
  `SPARK_SIDECAR_API_KEY=${randomBytes(32).toString('hex')}`,
  'SPARK_LOCAL_PORT=8765',
  'LNBITS_LOCAL_PORT=5100',
  'LNBITS_TEST_USERNAME=sparktest',
  `LNBITS_TEST_PASSWORD=${randomBytes(24).toString('hex')}`,
  `FIRST_INSTALL_TOKEN=${randomBytes(32).toString('hex')}`,
  ''
].join('\n')

try {
  writeFileSync(new URL('../.env', import.meta.url), env, {
    flag: 'wx',
    mode: 0o600
  })
  console.log(
    'Created private .env with a new dedicated wallet and credentials.'
  )
  console.log('Start with: docker compose up -d --build')
} catch (error) {
  if (error.code !== 'EEXIST') throw error
  console.log(
    '.env already exists; keeping the existing wallet and credentials.'
  )
}
