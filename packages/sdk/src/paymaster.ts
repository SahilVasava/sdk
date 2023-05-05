import { resolveProperties } from "@ethersproject/properties"
import { UserOperationStruct } from "@zerodevapp/contracts"
import { ethers } from "ethers"
import { signUserOp } from "./api"
import { ErrTransactionFailedGasChecks } from "./errors"
import { PaymasterAPI } from "./PaymasterAPI"
import { hexifyUserOp } from "./utils"
import { SupportedToken } from "./types"

export class VerifyingPaymasterAPI extends PaymasterAPI {
  constructor(
    readonly projectId: string,
    readonly paymasterUrl: string,
    readonly chainId: number,
    readonly entryPointAddress: string,
    readonly tokenAddress?: string,
  ) {
    super()
  }

  async getPaymasterResp(
    userOp: Partial<UserOperationStruct>
  ): Promise<object | undefined> {
    const resolvedUserOp = await resolveProperties(userOp)

    const hexifiedUserOp: any = hexifyUserOp(resolvedUserOp)

    const paymasterResp = await signUserOp(
      this.projectId,
      this.chainId,
      hexifiedUserOp,
      this.entryPointAddress,
      this.paymasterUrl,
      this.tokenAddress,
    )
    if (!paymasterResp) {
      throw ErrTransactionFailedGasChecks
    }

    return paymasterResp
  }
}