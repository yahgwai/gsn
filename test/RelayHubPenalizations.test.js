const { balance, BN, ether, expectEvent, expectRevert, send, time } = require('@openzeppelin/test-helpers')

const { getEip712Signature, getRelayRequest } = require('../src/js/relayclient/utils')

const RelayHub = artifacts.require('RelayHub')
const SampleRecipient = artifacts.require('./test/TestRecipient')
const TestSponsor = artifacts.require('./test/TestSponsorEverythingAccepted')
const Transaction = require('ethereumjs-tx')
const { privateToAddress } = require('ethereumjs-util')
const rlp = require('rlp')

const { expect } = require('chai')

contract('RelayHub Penalizations', function ([_, relayOwner, relay, otherRelay, sender, other]) { // eslint-disable-line no-unused-vars
  let relayHub
  let recipient
  let gasSponsor

  before(async function () {
    relayHub = await RelayHub.new({ gas: 8000000 })
    recipient = await SampleRecipient.new()
    gasSponsor = await TestSponsor.new()
    await recipient.setHub(relayHub.address)
    await gasSponsor.setHub(relayHub.address)
  })

  describe('penalizations', function () {
    const reporter = other
    let stake

    // Receives a function that will penalize the relay and tests that call for a penalization, including checking the
    // emitted event and penalization reward transfer. Returns the transaction receipt.
    async function expectPenalization (penalizeWithOpts) {
      const reporterBalanceTracker = await balance.tracker(reporter)
      const relayHubBalanceTracker = await balance.tracker(relayHub.address)

      // A gas price of zero makes checking the balance difference simpler
      const receipt = await penalizeWithOpts({
        from: reporter,
        gasPrice: 0
      })
      expectEvent.inLogs(receipt.logs, 'Penalized', {
        relay,
        sender: reporter,
        amount: stake.divn(2)
      })

      // The reporter gets half of the stake
      expect(await reporterBalanceTracker.delta()).to.be.bignumber.equals(stake.divn(2))

      // The other half is burned, so RelayHub's balance is decreased by the full stake
      expect(await relayHubBalanceTracker.delta()).to.be.bignumber.equals(stake.neg())

      return receipt
    }

    describe('penalizable behaviors', function () {
      const encodedCallArgs = {
        sender,
        recipient: '0x1820b744B33945482C17Dc37218C01D858EBc714',
        data: '0x1234',
        fee: 10,
        gasPrice: 50,
        gasLimit: 1000000,
        nonce: 0
      }

      const relayCallArgs = {
        gasPrice: 50,
        gasLimit: 1000000,
        nonce: 0,
        privateKey: '6370fd033278c143179d81c5526140625662b8daa446c22ee2d73db3707e620c' // relay's private key
      }

      before(function () {
        expect('0x' + privateToAddress('0x' + relayCallArgs.privateKey).toString('hex')).to.equal(relay.toLowerCase())
        // TODO: I don't want to refactor everything here, but this value is not available before 'before' is run :-(
        encodedCallArgs.gasSponsor = gasSponsor.address
      })

      beforeEach('staking for relay', async function () {
        await relayHub.stake(relay, time.duration.weeks(1), { value: ether('1') })
        stake = (await relayHub.getRelay(relay)).totalStake
      })

      describe('repeated relay nonce', async function () {
        it('penalizes transactions with same nonce and different data', async function () {
          const txDataSigA = getDataAndSignature(encodeRelayCall(encodedCallArgs, relayCallArgs))
          const txDataSigB = getDataAndSignature(encodeRelayCall(Object.assign(encodedCallArgs, { data: '0xabcd' }), relayCallArgs))

          await expectPenalization((opts) =>
            relayHub.penalizeRepeatedNonce(txDataSigA.data, txDataSigA.signature, txDataSigB.data, txDataSigB.signature, opts)
          )
        })

        it('penalizes transactions with same nonce and different gas limit', async function () {
          const txDataSigA = getDataAndSignature(encodeRelayCall(encodedCallArgs, relayCallArgs))
          const txDataSigB = getDataAndSignature(encodeRelayCall(encodedCallArgs, Object.assign(relayCallArgs, { gasLimit: 100 })))

          await expectPenalization((opts) =>
            relayHub.penalizeRepeatedNonce(txDataSigA.data, txDataSigA.signature, txDataSigB.data, txDataSigB.signature, opts)
          )
        })

        it('penalizes transactions with same nonce and different value', async function () {
          const txDataSigA = getDataAndSignature(encodeRelayCall(encodedCallArgs, relayCallArgs))
          const txDataSigB = getDataAndSignature(encodeRelayCall(encodedCallArgs, Object.assign(relayCallArgs, { value: 100 })))

          await expectPenalization((opts) =>
            relayHub.penalizeRepeatedNonce(txDataSigA.data, txDataSigA.signature, txDataSigB.data, txDataSigB.signature, opts)
          )
        })

        it('does not penalize transactions with same nonce and data, value, gasLimit, destination', async function () {
          const txDataSigA = getDataAndSignature(encodeRelayCall(encodedCallArgs, relayCallArgs))
          const txDataSigB = getDataAndSignature(encodeRelayCall(
            encodedCallArgs,
            Object.assign(relayCallArgs, { gasPrice: 70 }) // only gasPrice may be different
          ))

          await expectRevert(
            relayHub.penalizeRepeatedNonce(txDataSigA.data, txDataSigA.signature, txDataSigB.data, txDataSigB.signature),
            'tx is equal'
          )
        })

        it('does not penalize transactions with different nonces', async function () {
          const txDataSigA = getDataAndSignature(encodeRelayCall(encodedCallArgs, relayCallArgs))
          const txDataSigB = getDataAndSignature(encodeRelayCall(
            encodedCallArgs,
            Object.assign(relayCallArgs, { nonce: 1 })
          ))

          await expectRevert(
            relayHub.penalizeRepeatedNonce(txDataSigA.data, txDataSigA.signature, txDataSigB.data, txDataSigB.signature),
            'Different nonce'
          )
        })

        it('does not penalize transactions with same nonce from different relays', async function () {
          const txDataSigA = getDataAndSignature(encodeRelayCall(encodedCallArgs, relayCallArgs))
          const txDataSigB = getDataAndSignature(encodeRelayCall(
            encodedCallArgs,
            Object.assign(relayCallArgs, { privateKey: '0123456789012345678901234567890123456789012345678901234567890123' })
          ))

          await expectRevert(
            relayHub.penalizeRepeatedNonce(txDataSigA.data, txDataSigA.signature, txDataSigB.data, txDataSigB.signature),
            'Different signer'
          )
        })
      })

      describe('illegal call', async function () {
        describe('with pre-EIP155 signatures', async function () {
          it('penalizes relay transactions to addresses other than RelayHub', async function () {
            // Relay sending ether to another account
            const { transactionHash } = await send.ether(relay, other, ether('0.5'))
            const { data, signature } = await getDataAndSignatureFromHash(transactionHash)

            await expectPenalization((opts) => relayHub.penalizeIllegalTransaction(data, signature, opts))
          })

          it('penalizes relay transactions to illegal RelayHub functions (stake)', async function () {
            // Relay staking for a second relay
            const { tx } = await relayHub.stake(other, time.duration.weeks(1), {
              value: ether('1'),
              from: relay
            })
            const { data, signature } = await getDataAndSignatureFromHash(tx)

            await expectPenalization((opts) => relayHub.penalizeIllegalTransaction(data, signature, opts))
          })

          it('penalizes relay transactions to illegal RelayHub functions (penalize)', async function () {
            // A second relay is registered
            await relayHub.stake(otherRelay, time.duration.weeks(1), {
              value: ether('1'),
              from: other
            })

            // An illegal transaction is sent by it
            const stakeTx = await send.ether(otherRelay, other, ether('0.5'))

            // A relay penalizes it
            const stakeTxDataSig = await getDataAndSignatureFromHash(stakeTx.transactionHash)
            const penalizeTx = await relayHub.penalizeIllegalTransaction(
              stakeTxDataSig.data, stakeTxDataSig.signature, { from: relay }
            )

            // It can now be penalized for that
            const penalizeTxDataSig = await getDataAndSignatureFromHash(penalizeTx.tx)
            await expectPenalization((opts) =>
              relayHub.penalizeIllegalTransaction(penalizeTxDataSig.data, penalizeTxDataSig.signature, opts))
          })

          it('does not penalize legal relay transactions', async function () {
            // registerRelay is a legal transaction

            const registerTx = await relayHub.registerRelay(10, 'url.com', { from: relay })
            const registerTxDataSig = await getDataAndSignatureFromHash(registerTx.tx)

            await expectRevert(
              relayHub.penalizeIllegalTransaction(registerTxDataSig.data, registerTxDataSig.signature),
              'Legal relay transaction'
            )

            // relayCall is a legal transaction

            const fee = new BN('10')
            const gasPrice = new BN('1')
            const gasLimit = new BN('1000000')
            const senderNonce = new BN('0')
            const txData = recipient.contract.methods.emitMessage('').encodeABI()
            const sharedSigValues = {
              web3,
              senderAccount: sender,
              target: recipient.address,
              encodedFunction: txData,
              pctRelayFee: fee.toString(),
              gasPrice: gasPrice.toString(),
              gasLimit: gasLimit.toString(),
              senderNonce: senderNonce.toString(),
              relayHub: relayHub.address,
              relayAddress: relay
            }
            const { signature } = await getEip712Signature({
              ...sharedSigValues,
              gasSponsor: gasSponsor.address
            })
            await relayHub.depositFor(gasSponsor.address, {
              from: other,
              value: ether('1')
            })
            const relayRequest = getRelayRequest(sender, recipient.address, txData, fee, gasPrice, gasLimit, senderNonce, relay, gasSponsor.address)
            const relayCallTx = await relayHub.relayCall(relayRequest, signature, '0x', {
              from: relay,
              gasPrice,
              gasLimit
            })

            const relayCallTxDataSig = await getDataAndSignatureFromHash(relayCallTx.tx)
            await expectRevert(
              relayHub.penalizeIllegalTransaction(relayCallTxDataSig.data, relayCallTxDataSig.signature),
              'Legal relay transaction'
            )
          })
        })
      })

      describe.skip('with EIP155 signatures', function () {
      })
    })

    describe('penalizable relay states', async function () {
      context('with penalizable transaction', function () {
        let penalizableTxData
        let penalizableTxSignature

        beforeEach(async function () {
          // Relays are not allowed to transfer Ether
          const { transactionHash } = await send.ether(relay, other, ether('0.5'));
          ({
            data: penalizableTxData,
            signature: penalizableTxSignature
          } = await getDataAndSignatureFromHash(transactionHash))
        })

        // All of these tests use the same penalization function (we one we set up in the beforeEach block)
        function penalize () {
          return expectPenalization((opts) => relayHub.penalizeIllegalTransaction(penalizableTxData, penalizableTxSignature, opts))
        }

        // Checks that a relay can be penalized, but only once
        function testUniqueRelayPenalization () {
          it('relay can be penalized', async function () {
            await penalize()
          })

          it('relay cannot be penalized twice', async function () {
            await penalize()
            await expectRevert(penalize(), 'Unstaked relay')
          })
        }

        context('with unstaked relay', function () {
          before(async function () {
            await relayHub.removeRelayByOwner(relay)
            await time.increase(time.duration.weeks(1))
            await relayHub.unstake(relay)
          })

          it('account cannot be penalized', async function () {
            await expectRevert(penalize(), 'Unstaked relay')
          })

          context('with staked relay', function () {
            const unstakeDelay = time.duration.weeks(1)

            beforeEach(async function () {
              await relayHub.stake(relay, unstakeDelay, {
                value: stake,
                from: relayOwner
              })
            })

            testUniqueRelayPenalization()

            context('with registered relay', function () {
              beforeEach(async function () {
                await relayHub.registerRelay(10, 'url.com', { from: relay })
              })

              testUniqueRelayPenalization()

              it('RelayRemoved event is emitted', async function () {
                const { logs } = await penalize()
                expectEvent.inLogs(logs, 'RelayRemoved', {
                  relay,
                  unstakeTime: await time.latest()
                })
              })

              context('with removed relay', function () {
                beforeEach(async function () {
                  await relayHub.removeRelayByOwner(relay, { from: relayOwner })
                })

                testUniqueRelayPenalization()

                context('with unstaked relay', function () {
                  beforeEach(async function () {
                    await time.increase(unstakeDelay)
                    await relayHub.unstake(relay, { from: relayOwner })
                  })

                  it('relay cannot be penalized', async function () {
                    await expectRevert(penalize(), 'Unstaked relay')
                  })
                })
              })
            })
          })
        })
      })
    })

    function encodeRelayCall (encodedCallArgs, relayCallArgs) {
      const relayAddress = privateToAddress('0x' + relayCallArgs.privateKey).toString('hex')
      const relayRequest = getRelayRequest(
        encodedCallArgs.sender,
        encodedCallArgs.recipient,
        encodedCallArgs.data,
        encodedCallArgs.fee,
        encodedCallArgs.gasPrice,
        encodedCallArgs.gasLimit,
        encodedCallArgs.nonce,
        relayAddress,
        encodedCallArgs.gasSponsor
      )
      const encodedCall = relayHub.contract.methods.relayCall(relayRequest, '0xabcdef123456', '0x').encodeABI()

      const transaction = new Transaction({
        nonce: relayCallArgs.nonce,
        gasLimit: relayCallArgs.gasLimit,
        gasPrice: relayCallArgs.gasPrice,
        to: relayHub.address,
        value: relayCallArgs.value,
        data: encodedCall
      })

      transaction.sign(Buffer.from(relayCallArgs.privateKey, 'hex'))
      return transaction
    }

    async function getDataAndSignatureFromHash (txHash) {
      const rpcTx = await web3.eth.getTransaction(txHash)

      const tx = new Transaction({
        nonce: new BN(rpcTx.nonce),
        gasPrice: new BN(rpcTx.gasPrice),
        gasLimit: new BN(rpcTx.gas),
        to: rpcTx.to,
        value: new BN(rpcTx.value),
        data: rpcTx.input,
        v: rpcTx.v,
        r: rpcTx.r,
        s: rpcTx.s
      })

      return getDataAndSignature(tx)
    }

    function getDataAndSignature (tx) {
      const data = `0x${rlp.encode([tx.nonce, tx.gasPrice, tx.gasLimit, tx.to, tx.value, tx.data]).toString('hex')}`
      const signature = `0x${tx.r.toString('hex')}${tx.s.toString('hex')}${tx.v.toString('hex')}`

      return {
        data,
        signature
      }
    }
  })
})
