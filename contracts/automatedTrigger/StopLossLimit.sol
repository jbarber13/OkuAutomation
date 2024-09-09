// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.19;

import "./IAutomation.sol";
import "./AutomationMaster.sol";
//import "../interfaces/chainlink/AutomationCompatibleInterface.sol";
import "../libraries/ArrayMutation.sol";

import "../interfaces/ILimitOrderRegistry.sol";
import "../interfaces/uniswapV3/UniswapV3Pool.sol";
import "../interfaces/uniswapV3/ISwapRouter02.sol";
import "../interfaces/openzeppelin/Ownable.sol";
import "../interfaces/openzeppelin/IERC20.sol";
import "../interfaces/openzeppelin/SafeERC20.sol";

import "../oracle/IOracleRelay.sol";

///testing
import "hardhat/console.sol";

///@notice This contract owns and handles all logic associated with STOP_MARKET orders
///@notice STOP_LOSS_LIMIT orders check an external oracle for a pre-determined strike price AND/OR
/// a pre-determined stop price,
///once this price is reached, a market swap occurs
contract StopLossLimit is Ownable, IStopLossLimit {
    using SafeERC20 for IERC20;

    AutomationMaster public immutable MASTER;

    uint256 public stopLossLimitOrderCount;

    uint256[] public PendingOrderIds;

    mapping(uint256 => Order) public stopLossLimitOrders;

    constructor(AutomationMaster _master) {
        MASTER = _master;
    }

    function getPendingOrders()
        external
        view
        returns (uint256[] memory pendingOrderIds)
    {
        return PendingOrderIds;
    }

    function createOrderWithSwap(
        SwapParams calldata swapParams,
        uint256 strikePrice,
        uint256 stopPrice,
        IERC20 tokenIn,
        IERC20 tokenOut,
        address recipient,
        uint32 slippageBipsStrike,
        uint32 slippageBipsStop
    ) external override {
        require(
            swapParams.swapBips <= MASTER.MAX_BIPS(),
            "Invalid Slippage BIPS"
        );

        //take asset
        swapParams.swapTokenIn.safeTransferFrom(
            msg.sender,
            address(this),
            swapParams.swapAmountIn
        );

        (bool success, , uint256 finalAmountOut) = execute(
            swapParams.swapTarget,
            swapParams.txData,
            swapParams.swapAmountIn,
            swapParams.swapTokenIn,
            tokenIn,
            swapParams.swapBips
        );

        require(success, "swap failed");

        _createOrder(
            strikePrice,
            stopPrice,
            finalAmountOut,
            tokenIn,
            tokenOut,
            recipient,
            slippageBipsStrike,
            slippageBipsStop
        );
    }

    ///@param strikePrice is in terms of exchange rate of tokenIn / tokenOut,
    /// thus is dependent on direction
    function createOrder(
        uint256 strikePrice,
        uint256 stopPrice,
        uint256 amountIn,
        IERC20 tokenIn,
        IERC20 tokenOut,
        address recipient,
        uint32 slippageBipsStrike,
        uint32 slippageBipsStop
    ) external override {
        //take asset
        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);

        _createOrder(
            strikePrice,
            stopPrice,
            amountIn,
            tokenIn,
            tokenOut,
            recipient,
            slippageBipsStrike,
            slippageBipsStop
        );
    }

    function _createOrder(
        uint256 strikePrice,
        uint256 stopPrice,
        uint256 amountIn,
        IERC20 tokenIn,
        IERC20 tokenOut,
        address recipient,
        uint32 slippageBipsStrike,
        uint32 slippageBipsStop
    ) internal {
        //verify both oracles exist, as we need both to calc the exchange rate
        require(
            address(MASTER.oracles(tokenIn)) != address(0x0),
            "tokenIn Oracle !exist"
        );
        require(
            address(MASTER.oracles(tokenIn)) != address(0x0),
            "tokenOut Oracle !exist"
        );

        require(
            stopLossLimitOrderCount < MASTER.maxPendingOrders(),
            "Max Order Count Reached"
        );
        require(
            slippageBipsStop <= MASTER.MAX_BIPS() &&
                slippageBipsStrike <= MASTER.MAX_BIPS(),
            "Invalid Slippage BIPS"
        );

        //verify order amount is at least the minimum todo check here or only when limit order is created?
        MASTER.checkMinOrderSize(tokenIn, amountIn);
        stopLossLimitOrderCount++;
        stopLossLimitOrders[stopLossLimitOrderCount] = Order({
            orderId: stopLossLimitOrderCount,
            strikePrice: strikePrice,
            stopPrice: stopPrice,
            amountIn: amountIn,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            recipient: recipient,
            slippageBipsStrike: slippageBipsStrike,
            slippageBipsStop: slippageBipsStop,
            direction: MASTER.getExchangeRate(tokenIn, tokenOut) > strikePrice //exchangeRate in/out > strikePrice
        });

        PendingOrderIds.push(stopLossLimitOrderCount);

        emit OrderCreated(stopLossLimitOrderCount);
    }

    function adminCancelOrder(uint256 orderId) external onlyOwner {
        Order memory order = stopLossLimitOrders[orderId];
        require(_cancelOrder(order), "Order not active");
    }

    ///@notice only the order recipient can cancel their order
    ///@notice only pending orders can be cancelled
    function cancelOrder(uint256 orderId) external {
        Order memory order = stopLossLimitOrders[orderId];
        require(msg.sender == order.recipient, "Only Order Owner");
        require(_cancelOrder(order), "Order not active");
    }

    function _cancelOrder(Order memory order) internal returns (bool) {
        for (uint i = 0; i < PendingOrderIds.length; i++) {
            if (PendingOrderIds[i] == order.orderId) {
                //remove from pending array
                PendingOrderIds = ArrayMutation.removeFromArray(
                    i,
                    PendingOrderIds
                );

                //refund tokenIn amountIn to recipient
                order.tokenIn.safeTransfer(order.recipient, order.amountIn);

                //emit event
                emit OrderCancelled(order.orderId);

                //short circuit loop
                return true;
            }
        }
        return false;
    }

    //check upkeep
    function checkUpkeep(
        bytes calldata
    )
        external
        view
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        for (uint i = 0; i < PendingOrderIds.length; i++) {
            Order memory order = stopLossLimitOrders[PendingOrderIds[i]];
            (bool inRange, bool strike, uint256 exchangeRate) = checkInRange(order);
            if (inRange) {
                return (
                    true,
                    abi.encode(
                        MasterUpkeepData({
                            orderType: OrderType.STOP_LOSS_LIMIT,
                            target: address(0x0),
                            txData: "0x",
                            pendingOrderIdx: i,
                            orderId: order.orderId,
                            tokenIn: order.tokenIn,
                            tokenOut: order.tokenOut,
                            bips: strike ? order.slippageBipsStrike : order.slippageBipsStop,//bips based on strike or stop fill
                            amountIn: order.amountIn,
                            exchangeRate: exchangeRate
                        })
                    )
                );
            }
        }
    }

    //perform upkeep - todo onlyOwner or verify sender?
    ///@notice recipient of swap should be this contract,
    ///as we need to account for tokens received.
    ///This contract will then forward the tokens to the user
    /// target refers to some contract where when we send @param performData,
    ///that contract will exchange our tokenIn for tokenOut with at least minAmountReceived
    /// pendingOrderIdx is the index of the pending order we are executing,
    ///this pending order is removed from the array via array mutation
    function performUpkeep(bytes calldata performData) external override {
        MasterUpkeepData memory data = abi.decode(
            performData,
            (MasterUpkeepData)
        );
        Order memory order = stopLossLimitOrders[
            PendingOrderIds[data.pendingOrderIdx]
        ];
        //deduce if we are filling stop or strike
        (bool inRange, bool strike, ) = checkInRange(order);
        require(inRange, "order ! in range");

        //asing bips
        uint32 bips;
        strike ? bips = order.slippageBipsStrike : bips = order
            .slippageBipsStop;

        (bool success, bytes memory result, uint256 finalAmountOut) = execute(
            data.target,
            data.txData,
            order.amountIn,
            order.tokenIn,
            order.tokenOut,
            order.slippageBipsStop
        );

        //handle accounting
        if (success) {
            //remove from pending array
            PendingOrderIds = ArrayMutation.removeFromArray(
                data.pendingOrderIdx,
                PendingOrderIds
            );

            //send tokenOut to recipient
            order.tokenOut.safeTransfer(order.recipient, finalAmountOut);
        }

        //emit
        emit OrderProcessed(order.orderId, success, result);
    }

    ///@notice execute swap via @param txData
    function execute(
        address target,
        bytes memory txData,
        uint256 amountIn,
        IERC20 tokenIn,
        IERC20 tokenOut,
        uint32 bips
    )
        internal
        returns (bool success, bytes memory result, uint256 finalAmountOut)
    {
        //update accounting
        uint256 initialTokenOut = tokenOut.balanceOf(address(this));

        //approve
        updateApproval(target, tokenIn, amountIn);

        //perform the call
        (success, result) = target.call(txData);

        if (success) {
            uint256 finalTokenOut = tokenOut.balanceOf(address(this));

            //if success, we expect tokenIn balance to decrease by amountIn
            //and tokenOut balance to increase by at least minAmountReceived
            require(
                finalTokenOut - initialTokenOut >
                    MASTER.getMinAmountReceived(
                        amountIn,
                        tokenIn,
                        tokenOut,
                        bips
                    ),
                "Too Little Received"
            );

            finalAmountOut = finalTokenOut - initialTokenOut;
        }
    }

    ///@notice if current approval is insufficient, approve max
    ///@notice oz safeIncreaseAllowance controls for tokens that require allowance to be reset to 0 before increasing again
    function updateApproval(
        address spender,
        IERC20 token,
        uint256 amount
    ) internal {
        // get current allowance
        uint256 currentAllowance = token.allowance(address(this), spender);
        if (currentAllowance < amount) {
            // amount is a delta, so need to pass max - current to avoid overflow
            token.safeIncreaseAllowance(
                spender,
                type(uint256).max - currentAllowance
            );
        }
    }

    function checkInRange(
        Order memory order
    ) internal view returns (bool inRange, bool strike, uint256 exchangeRate) {
        exchangeRate = MASTER.getExchangeRate(order.tokenIn, order.tokenOut);
        if (order.direction) {
            //check for strike price
            if (exchangeRate <= order.strikePrice) {
                return (true, true, exchangeRate);
            }
            //check for stop price
            if (exchangeRate >= order.stopPrice) {
                return (true, false, exchangeRate);
            }
        } else {
            //check for strike price
            if (exchangeRate >= order.strikePrice) {
                return (true, true, exchangeRate);
            }
            //check for stop price
            if (exchangeRate <= order.stopPrice) {
                return (true, false, exchangeRate);
            }
        }
    }
}