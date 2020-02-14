pragma solidity ^0.5.16;
pragma experimental ABIEncoderV2;

import "../utils/EIP712Sig.sol";

interface IGasSponsor {

    /**
     * return the relayHub of this contract.
     */
    function getHubAddr() external view returns (address);

    /**
     * Can be used to determine if the contract can pay for incoming calls before making any.
     * @return the sponsor's deposit in the RelayHub.
     */
    function getRelayHubDeposit() external view returns (uint256);

    function getGasLimitsForSponsorCalls()
    external
    view
    returns (
        GSNTypes.SponsorLimits memory
    );

    /**
     * Called by Relay (and RelayHub), to validate if this recipient accepts this call.
     * Note: Accepting this call means paying for the tx whether the relayed call reverted or not.
     *  @param relayRequest - the full relay request structure
     *  @param approvalData - extra dapp-specific data (e.g. signature from trusted party)
     *  @param maxPossibleCharge - depending on values returned from {@link getGasLimitsForSponsorCalls},
     *         the RelayHub will calculate the maximum possible amount the user may be charged
     */
    function acceptRelayedCall(
        GSNTypes.RelayRequest calldata relayRequest,
        bytes calldata approvalData,
        uint256 maxPossibleCharge
    )
    external
    view
    returns (uint256, bytes memory);

    /** this method is called before the actual relayed function call.
     * It may be used to charge the caller before
     * (in conjunction with refunding him later in postRelayedCall for example).
     * the method is given all parameters of acceptRelayedCall and actual used gas.
     *
     *
     * NOTICE: if this method modifies the contract's state, it must be
     * protected with access control i.e. require msg.sender == getHubAddr()
     *
     *
     * Revert in this functions causes a revert of the client's relayed call but not in the entire transaction
     * (that is, the relay will still get compensated)
     */
    function preRelayedCall(bytes calldata context) external returns (bytes32);

    /** this method is called after the actual relayed function call.
     * It may be used to record the transaction (e.g. charge the caller by some contract logic) for this call.
     * the method is given all parameters of acceptRelayedCall, and also the success/failure status and actual used gas.
     *
     *
     * NOTICE: if this method modifies the contract's state,
     * it must be protected with access control i.e. require msg.sender == getHubAddr()
     *
     *
     * @param success - true if the relayed call succeeded, false if it reverted
     * @param expectedChargeEstimate - estimation of how much the recipient will be charged.
     *   This information may be used to perform local bookkeeping and
     *   charge the sender for this call (e.g. in tokens).
     * @param preRetVal - preRelayedCall() return value passed back to the recipient
     *
     * Revert in this functions causes a revert of the client's relayed call but not in the entire transaction
     * (that is, the relay will still get compensated)
     */
    function postRelayedCall(
        bytes calldata context,
        bool success,
        uint expectedChargeEstimate,
        bytes32 preRetVal,
        uint256 gasUsedUntilPostRelayedCall,
        uint256 txFee,
        uint256 gasPrice
    ) external;

}
