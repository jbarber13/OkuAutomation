import { Signer } from "ethers"
import { IERC20, IERC20__factory, IOracleRelay, MasterKeeper, MasterKeeperV2, MasterKeeperV2__factory, UniV3TickTwapOracle__factory, UniswapV3Pool, UniswapV3Pool__factory } from "../typechain-types"
import { currentBlock, resetCurrentArb } from "../util/block"
import { ethers } from "hardhat"
import { expect } from "chai"
import { stealMoney } from "../util/money"
import { getEvent } from "../util/msc"

const LimitOrderRegistry = "0x54df9e11c7933a9ca3bd1e540b63da15edae40bf"//arbiscan
const pool = "0xc31e54c7a869b9fcbecc14363cf510d1c41fa443"//WETH/USDC.e pool @ 500

let mkv2: MasterKeeperV2
let tickOracle: IOracleRelay

let UniPool: UniswapV3Pool
let WETH: IERC20 //weth token0 0x82af49447d8a07e3bd95bd0d56f35241523fbab1
let USDC: IERC20 //USDC.e token1 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8

const wethWhale = "0xE4f718a0b06D91cF6ff436d4445315ABDF99247b"
const usdcWhale = "0x25681Ab599B4E2CEea31F8B498052c53FC2D74db"
const wethAmount = ethers.parseEther("1.65")
const usdcAmount = ethers.parseUnits("5000", 6)

let Frank: Signer
let Bob: Signer //stop-market
let Andy: Signer

///All tests are performed as if on Arbitrum
///Testing is on the Arb WETH/USDC.e pool @ 500
describe("Master Upkeep V2 Testing on Arbitrum", () => {

    before(async () => {
        console.log("STARTING")
        await resetCurrentArb()
        console.log("Testing on ARB @", (await currentBlock())?.number)

        //connect to signers
        const signers = await ethers.getSigners()
        Frank = signers[0]
        Bob = signers[1]
        Andy = signers[2]

        UniPool = UniswapV3Pool__factory.connect(pool, Frank)
        WETH = IERC20__factory.connect(await UniPool.token0(), Frank)
        USDC = IERC20__factory.connect(await UniPool.token1(), Frank)

    })

    it("Deploy", async () => {
        //Deploy keeper
        mkv2 = await new MasterKeeperV2__factory(Frank).deploy(LimitOrderRegistry)
        await mkv2.deploymentTransaction()

        //deploy tick oracle
        tickOracle = await new UniV3TickTwapOracle__factory(Frank).deploy(
            14400,
            pool
        )

        await tickOracle.deploymentTransaction()
        console.log("Current tick: ", Number(await tickOracle.currentValue()))
    })

    it("Register", async () => {
        //register pool
        await mkv2.connect(Frank).addPools([pool])
        const list = await mkv2.getList()
        expect(list.length).to.eq(1, "List length is correct")

        //register oracle
        await mkv2.connect(Frank).registerOracles([await tickOracle.getAddress()], [pool])
        expect(await mkv2.oracles(pool)).to.eq(await tickOracle.getAddress(), "Pool oracle registered")


    })

    it("Check upkeep", async () => {

        //should be no upkeep needed yet
        const result = await mkv2.checkUpkeep("0x")
        expect(result.upkeepNeeded).to.eq(false)
        expect(result.performData).to.eq("0x")
    })
})

describe("Execute Stop-Market Upkeep", () => {
    ///stop-market orders simply do a market swap once the strike tick is reached via the TWAP oracle

    //setup
    before(async () => {
        //steal money for Bob
        await stealMoney(wethWhale, await Bob.getAddress(), await WETH.getAddress(), wethAmount)
    })

    it("Create stop-market order", async () => {
        const currentTick = await tickOracle.currentValue()
        console.log("CURRENT TICK: ", currentTick)
        await WETH.connect(Bob).approve(await mkv2.getAddress(), wethAmount)
        await mkv2.connect(Bob).createMarketStopOrder(
            pool,
            wethAmount,
            true,
            wethAmount / 2n,
            (await currentBlock())?.timestamp! + 120,
            currentTick + 5n
        )

        const filter = mkv2.filters.OrderCreated
        const events = await mkv2.queryFilter(filter, -1)
        const event = events[0].args
        expect(Number(event[0])).to.eq(3, "STOP_MARKET")
        expect(Number(event[1])).to.eq(1, "First order Id")


    })

    it("Do a large swap to move the market and execute the order", async () => {
        
    })

    it("Check, perform, and verify upkeep", async () => {

    })
})

describe("Execute Stop-Limit and Stop-Close Upkeep", () => {


    //setup
    before(async () => {


    })

    it("Register the pool", async () => {

    })

    it("Check, perform, and verify upkeep", async () => {

    })
})