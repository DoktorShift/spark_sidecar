# Local Spark / LNbits integration

The Compose project is `spark-lnbits-test`. It runs the sidecar from this checkout
with Node 24 and the official `lnbits/lnbits:v1.6.2` image. Both published ports
bind to IPv4 loopback. The initial network is **MAINNET**, so payments use real sats.
Use only the generated dedicated test wallet.

## Start and inspect

```bash
npm ci
npm test
npm run stack:init
docker compose up -d --build
npm run stack:check
docker compose ps
```

`stack:check` completes first-install setup using the credentials and setup token
in `.env`. It creates the `Spark integration test` LNbits wallet and a 1,000-sat
invoice, saving the invoice and Spark request ID to `.local/check-stack.json`.
It also verifies API-key authentication, the configured funding source, live
Spark balance, LNbits/Spark total-balance reconciliation, invoice status and SSE
connectivity. It does not send payments.
It reuses the saved invoice on later runs instead of creating a new one.

Open <http://127.0.0.1:5100> and sign in with `LNBITS_TEST_USERNAME` and
`LNBITS_TEST_PASSWORD` from `.env`. The pending invoice is in the test wallet's
payment history. Its BOLT11 is also saved in `.local/check-stack.json`.
No secrets need to be pasted into chat or shell commands.

`SPARK_LOCAL_PORT` and `LNBITS_LOCAL_PORT` in `.env` control host ports. The
internal endpoint stays `http://sidecar:8765`; container-local `127.0.0.1` would
refer to the LNbits container itself. Keep `LNBITS_ADMIN_UI=true`: disabling it
in this LNbits version enables verbose environment-settings logging.

The sidecar `/health` endpoint only checks the HTTP process. The live balance
check verifies actual SDK initialization. LNbits health requires a JSON health
response, so its first-install HTML redirect is not counted as ready.

## Payment and restart checklist

The stack can initialize and create invoices with an empty wallet. Complete the
following with small test amounts before considering deployment:

1. Pay the saved 1,000-sat invoice from an external Lightning wallet. Wait for
   LNbits to mark it paid, then run `npm run stack:check` again. Check the Spark
   settled status and LNbits wallet credit; receipt clearing can take time.
2. Create an invoice in an external Lightning wallet and pay it from the LNbits
   test wallet. Leave enough balance for fees. The configured minimum reserve is
   5,000 msat (5 sats); a route can require a larger allowance.
3. Confirm outgoing success, preimage, actual fee and corresponding balance debit
   in LNbits and the receiving wallet. A payment between accounts on this same
   LNbits instance can be internal and does not establish Spark sending works.
4. Recreate both containers, retaining `.env` and the data volume:

   ```bash
   docker compose up -d --force-recreate --wait --wait-timeout 90
   npm run stack:check
   ```

   Check that the same invoice ID and payment history survive, with no duplicate
   credit or payment. This is stronger than a health check.

5. Test a missed notification: create another small LNbits invoice, stop LNbits
   with `docker compose stop lnbits`, and pay that invoice externally. Start
   LNbits again with `docker compose start lnbits`. Verify that its invoice-status
   checks recover the credit. SSE connectivity alone does not prove this path.

If the saved invoice expires unpaid, remove only `.local/check-stack.json` and
rerun the check to create another one. Keep `.env` and the database.

```bash
docker compose logs --tail=100 sidecar lnbits
docker compose down
```

`down` retains the database volume. Do not use `down -v` for a funded instance.
The Spark recovery seed is in `.env`; LNbits account balances and payment records
are in the Docker volume. Back up both privately before depositing funds.
This local stack allows HTTP login cookies because it binds to loopback; a VPS
deployment needs its own service, network and HTTPS configuration.

## Upstream PR assessment

Reviewed and integrated locally on 2026-10-22, starting from upstream
`d6a1ee944e598fc23e456d0d139277bf13fd8f4a`:

| PR                                                                       | Tested head                                | Decision                                                             |
| ------------------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------- |
| [#25: Spark SDK 0.13.0](https://github.com/lnbits/spark_sidecar/pull/25) | `d27d6abc92bbe7cd8d382981fe7dcb0323c48303` | Include. Migrates the SDK and the payment retry identifier together. |
| [#26: pagination count](https://github.com/lnbits/spark_sidecar/pull/26) | `8f8e88abc6f5d7a9efa9d47d4305c52d09bbcfa6` | Include for the test stack, with the logging adjustment below.       |

PR #25 replaces the old `idempotencyKey` argument with the SDK's `transferId`
UUID. The UUID is deterministic for the network and invoice payment hash, so
retries preserve their identity across restart, invoice case and fee changes.
Tests exercise the actual pinned SDK's forwarding to transfer preparation,
preimage swap and provider request. It also updates gRPC to 1.14.5; the installed
dependency tree reports zero npm audit findings. The live integration below
validated initialization, invoice creation, a funded outgoing transfer and
subsequent payment-status reconciliation.

PR #26 finishes payment-history scans in one lookup, including short and empty
pages, and rejects invalid or repeated cursors. This recovers existing payments
beyond page two before dispatch and detects ambiguous attempts on later pages.
The tradeoff is loss of the old two-page work bound: long histories or slow
providers can exceed LNbits' 30-second request timeout. Before production, assess
large-wallet lookup latency and consider an explicit lookup deadline while
preserving ambiguous/pending behavior. It does not establish load capacity.

The PR's raw SDK exception logging was removed locally because SDK exceptions
can contain sensitive request data. Payment recovery still uses the stable
transfer ID when the advisory history read fails. No upstream PR was merged or
commented on by this work; both are integrated into this fork's test-stack branch.

## Validation recorded on 2026-10-22

- All 46 Node tests passed after combining both PRs and the logging adjustment.
  These cover incoming receipt clearing, duplicate sends, full pagination,
  provider failures and HTTP/SSE recovery in fresh processes using fixtures.
- Prettier passed. Pyright completed with no Python sources to check.
- npm audit reported zero vulnerabilities after installing the updated lockfile.
- Both Compose services started; LNbits logged a real `SparkL2Wallet` connection
  and a zero-msat backend balance.
- The live smoke check passed authentication, balance, LNbits admin setup,
  creation of a real 1,000-sat invoice, pending invoice lookup and SSE connection.
- Both containers were replaced and became healthy. The same saved invoice ID,
  LNbits account and zero balance were recovered, and the smoke check passed
  again. The invoice was still unpaid, so this does not prove funded recovery.
- The user then tested external payments through a separate LNbits wallet:
  50 sats received, 30 sats sent, with a 3-sat outgoing fee. Both records were
  verified as successful in LNbits. The outgoing sidecar lookup returned
  `TRANSFER_COMPLETED` with a preimage. It initially remained pending in LNbits
  and was reconciled to success by a payment-status request.
- Both containers were replaced again after settlement. Spark reconnected with
  17 sats, and the built-in LNbits audit confirmed 17 sats of LNbits balances and
  17 sats at the backend. The smoke check passed again. The script's original
  1,000-sat invoice and another 600-sat invoice remained pending/unpaid.

Recovery of a payment made while LNbits is offline remains untested. The fixture
tests do not replace that live check. The existing LND-backed deployments were
not changed.

### Open observation: browser refresh

The user reported needing a manual page refresh to see the new balance and
transaction list. Payment transport and reconciled balances were verified, but
automatic browser updates are not yet verified. LNbits accepted the wallet's
WebSocket connection after restart. That alone does not prove it delivered the
settlement event.

In the pinned LNbits frontend, `lnbits-payment-list` calls
`recheckPendingPayments()` when loading its list; that method performs a single
request rather than recurring polling. A later settlement can therefore remain
invisible if no WebSocket update triggers another load. This is a possible
explanation for delayed outgoing updates, not a confirmed explanation for the
reported incoming behavior. Reproduce the next receipt while observing sidecar
SSE, LNbits settlement and browser WebSocket messages before assigning the
cause. No LNbits frontend patch has been applied.
