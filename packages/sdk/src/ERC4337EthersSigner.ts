import { Deferrable, defineReadOnly } from '@ethersproject/properties'
import { Provider, TransactionRequest, TransactionResponse } from '@ethersproject/providers'
import { Signer } from '@ethersproject/abstract-signer'

import { Bytes } from 'ethers'
import { ERC4337EthersProvider } from './ERC4337EthersProvider'
import { ClientConfig } from './ClientConfig'
import { HttpRpcClient } from './HttpRpcClient'
import { UserOperationStruct } from '@account-abstraction/contracts'
import { BaseAccountAPI } from './BaseAccountAPI'

export class ERC4337EthersSigner extends Signer {
  // TODO: we have 'erc4337provider', remove shared dependencies or avoid two-way reference
  constructor(
    readonly config: ClientConfig,
    readonly originalSigner: Signer,
    readonly erc4337provider: ERC4337EthersProvider,
    readonly httpRpcClient: HttpRpcClient,
    readonly smartAccountAPI: BaseAccountAPI) {
    super()
    defineReadOnly(this, 'provider', erc4337provider)
  }

  address?: string

  delegateCopy(): ERC4337EthersSigner {
    // copy the account API except with delegate mode set to true
    const delegateAccountAPI = Object.assign({}, this.smartAccountAPI)
    Object.setPrototypeOf(delegateAccountAPI, Object.getPrototypeOf(this.smartAccountAPI))
    delegateAccountAPI.delegateMode = true
    return new ERC4337EthersSigner(this.config, this.originalSigner, this.erc4337provider, this.httpRpcClient, delegateAccountAPI)
  }

  // This one is called by Contract. It signs the request and passes in to Provider to be sent.
  async sendTransaction(transaction: Deferrable<TransactionRequest>): Promise<TransactionResponse> {
    // `populateTransaction` internally calls `estimateGas`.
    // Some providers revert if you try to call estimateGas without the wallet first having some ETH,
    // which is going to be the case here if we use paymasters.  Therefore we set the gas price to
    // 0 to ensure that estimateGas works even if the wallet has no ETH.
    if (transaction.maxFeePerGas || transaction.maxPriorityFeePerGas) {
      transaction.maxFeePerGas = 0
      transaction.maxPriorityFeePerGas = 0
    } else {
      transaction.gasPrice = 0
    }

    const tx: TransactionRequest = await this.populateTransaction(transaction)
    await this.verifyAllNecessaryFields(tx)
    let userOperation: UserOperationStruct
    userOperation = await this.smartAccountAPI.createSignedUserOp({
      target: tx.to ?? '',
      data: tx.data?.toString() ?? '',
      value: tx.value,
      gasLimit: tx.gasLimit,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    })
    const transactionResponse = await this.erc4337provider.constructUserOpTransactionResponse(userOperation)

    // Invoke the transaction hook
    this.config.hooks?.transactionStarted?.({
      hash: transactionResponse.hash,
      from: tx.from!,
      to: tx.to!,
      value: tx.value || 0,
      sponsored: userOperation.paymasterAndData !== '0x',
    })

    try {
      await this.httpRpcClient.sendUserOpToBundler(userOperation)
    } catch (error: any) {
      // console.error('sendUserOpToBundler failed', error)
      throw this.unwrapError(error)
    }
    // TODO: handle errors - transaction that is "rejected" by bundler is _not likely_ to ever resolve its "wait()"
    return transactionResponse
  }

  unwrapError(errorIn: any): Error {
    if (errorIn.body != null) {
      const errorBody = JSON.parse(errorIn.body)
      let paymasterInfo: string = ''
      let failedOpMessage: string | undefined = errorBody?.error?.message
      if (failedOpMessage?.includes('FailedOp') === true) {
        // TODO: better error extraction methods will be needed
        const matched = failedOpMessage.match(/FailedOp\((.*)\)/)
        if (matched != null) {
          const split = matched[1].split(',')
          paymasterInfo = `(paymaster address: ${split[1]})`
          failedOpMessage = split[2]
        }
      }
      const error = new Error(`The bundler has failed to include UserOperation in a batch: ${failedOpMessage} ${paymasterInfo})`)
      error.stack = errorIn.stack
      return error
    }
    return errorIn
  }

  async verifyAllNecessaryFields(transactionRequest: TransactionRequest): Promise<void> {
    if (transactionRequest.to == null) {
      throw new Error('Missing call target')
    }
    if (transactionRequest.data == null && transactionRequest.value == null) {
      // TBD: banning no-op UserOps seems to make sense on provider level
      throw new Error('Missing call data or value')
    }
  }

  connect(provider: Provider): Signer {
    throw new Error('changing providers is not supported')
  }

  async getAddress(): Promise<string> {
    if (this.address == null) {
      this.address = await this.erc4337provider.getSenderAccountAddress()
    }
    return this.address
  }

  async signMessage(message: Bytes | string): Promise<string> {
    return await this.originalSigner.signMessage(message)
  }

  async signTransaction(transaction: Deferrable<TransactionRequest>): Promise<string> {
    throw new Error('not implemented')
  }

  async signUserOperation(userOperation: UserOperationStruct): Promise<string> {
    const message = await this.smartAccountAPI.getUserOpHash(userOperation)
    return await this.originalSigner.signMessage(message)
  }

}
