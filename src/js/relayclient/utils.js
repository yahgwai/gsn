const ethUtils = require('ethereumjs-util')
const EthCrypto = require('eth-crypto')
const web3Utils = require('web3-utils')

const CallData = require('./EIP712/CallData')
const RelayData = require('./EIP712/RelayData')
const getDataToSign = require('./EIP712/Eip712Helper')

function removeHexPrefix (hex) {
  return hex.replace(/^0x/, '')
}

const zeroPad = '0000000000000000000000000000000000000000000000000000000000000000'

function padTo64 (hex) {
  if (hex.length < 64) {
    hex = (zeroPad + hex).slice(-64)
  }
  return hex
}

module.exports = {
  register_new_relay: async function (relayHub, stake, delay, txFee, url, account) {
    await relayHub.stake(account, delay, {
      from: account,
      value: stake
    })
    return relayHub.registerRelay(txFee, url, { from: account })
  },

  getEip712Signature: async function (
    {
      web3,
      methodSuffix = '',
      jsonStringifyRequest = false,
      senderAccount,
      senderNonce,
      target,
      encodedFunction,
      pctRelayFee,
      gasPrice,
      gasLimit,
      gasSponsor,
      relayHub,
      relayAddress
    }) {
    if (
      typeof gasPrice !== 'string' ||
      typeof gasLimit !== 'string' ||
      typeof pctRelayFee !== 'string' ||
      typeof gasSponsor !== 'string' ||
      typeof senderNonce !== 'string'
    ) {
      throw Error('using wrong types will cause signatures to be invalid')
    }
    let data = await getDataToSign({
      web3,
      senderAccount,
      senderNonce,
      target,
      encodedFunction,
      pctRelayFee,
      gasPrice,
      gasLimit,
      gasSponsor,
      relayHub,
      relayAddress
    })
    if (jsonStringifyRequest) {
      data = JSON.stringify(data)
    }
    return new Promise((resolve, reject) => {
      web3.currentProvider.send({
        method: 'eth_signTypedData' + methodSuffix,
        params: [senderAccount, data],
        from: senderAccount
      }, (err, res) => {
        if (err) {
          reject(err)
        } else {
          resolve({
            signature: res.result,
            data
          })
        }
      })
    })
  },

  getRelayRequest: function (sender, recipient, txData, fee, gasPrice, gasLimit, senderNonce, relay, gasSponsor) {
    return {
      callData: new CallData({
        target: recipient,
        gasLimit: gasLimit.toString(),
        gasPrice: gasPrice.toString(),
        encodedFunction: txData
      }),
      relayData: new RelayData({
        senderAccount: sender,
        senderNonce: senderNonce.toString(),
        relayAddress: relay,
        pctRelayFee: fee.toString(),
        gasSponsor
      })
    }
  },

  getTransactionSignature: async function (web3, account, hash) {
    let sig_
    try {
      sig_ = await new Promise((resolve, reject) => {
        try {
          web3.eth.personal.sign(hash, account, (err, res) => {
            if (err) {
              reject(err)
            } else {
              resolve(res)
            }
          })
        } catch (e) {
          reject(e)
        }
      })
    } catch (e) {
      sig_ = await new Promise((resolve, reject) => {
        web3.eth.sign(hash, account, (err, res) => {
          if (err) {
            reject(err)
          } else {
            resolve(res)
          }
        })
      })
    }

    const signature = ethUtils.fromRpcSig(sig_)
    const sig = web3Utils.bytesToHex(signature.r) + removeHexPrefix(web3Utils.bytesToHex(signature.s)) + removeHexPrefix(web3Utils.toHex(signature.v))

    return sig
  },

  getTransactionSignatureWithKey: function (privKey, hash, withPrefix = true) {
    let signed
    if (withPrefix) {
      const msg = Buffer.concat([Buffer.from('\x19Ethereum Signed Message:\n32'), Buffer.from(removeHexPrefix(hash), 'hex')])
      signed = web3Utils.sha3('0x' + msg.toString('hex'))
    } else { signed = hash }
    const keyHex = '0x' + Buffer.from(privKey).toString('hex')
    const sig_ = EthCrypto.sign(keyHex, signed)
    const signature = ethUtils.fromRpcSig(sig_)
    const sig = web3Utils.bytesToHex(signature.r) + removeHexPrefix(web3Utils.bytesToHex(signature.s)) + removeHexPrefix(web3Utils.toHex(signature.v))
    return sig
  },

  getEcRecoverMeta: function (message, signature) {
    if (typeof signature === 'string') {
      const r = this.parseHexString(signature.substr(2, 65))
      const s = this.parseHexString(signature.substr(66, 65))
      const v = this.parseHexString(signature.substr(130, 2))

      signature = {
        v: v,
        r: r,
        s: s
      }
    }
    const msg = Buffer.concat([Buffer.from('\x19Ethereum Signed Message:\n32'), Buffer.from(removeHexPrefix(message), 'hex')])
    const signed = web3Utils.sha3('0x' + msg.toString('hex'))
    const bufSigned = Buffer.from(removeHexPrefix(signed), 'hex')
    const signer = ethUtils.bufferToHex(ethUtils.pubToAddress(ethUtils.ecrecover(bufSigned, signature.v, signature.r, signature.s)))
    return signer
  },

  parseHexString: function (str) {
    var result = []
    while (str.length >= 2) {
      result.push(parseInt(str.substring(0, 2), 16))

      str = str.substring(2, str.length)
    }

    return result
  },
  removeHexPrefix: removeHexPrefix,
  padTo64: padTo64,

  isSameAddress: function (address1, address2) {
    return address1.toLowerCase() === address2.toLowerCase()
  }
}
