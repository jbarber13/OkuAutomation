import hre, { network } from "hardhat";
import { DeployContract } from "../util/deploy";
import { currentBlock, resetCurrent, resetCurrentArb, resetCurrentBase, resetCurrentBsc, resetCurrentOP, resetCurrentOPblock, resetCurrentPoly, resetCurrentZksync } from "../util/block";
import { AutomatedTriggerSwap, AutomatedTriggerSwap__factory, IERC20__factory, IOracleRelay, MasterKeeper, MasterKeeper__factory, OracleRelay__factory, UniswapV3Pool__factory } from "../typechain-types";
import { limitOrderData } from "./limitOrderData";
import { Signer } from "ethers";
import { ceaseImpersonation, impersonateAccount } from "../util/impersonator";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { decodeUpkeepData, generateUniTx, getStrikePrice } from "../util/msc";
import { a, o } from "../util/addresser";

const { ethers } = require("hardhat");

//"https://github.com/adrastia-oracle/oku-automation-config/blob/main/worker-config.ts"

let triggerAddr: string //"0x8327B0168858bd918A0177e89b2c172475F6B16f"//second deploy//0x4f38FA4F676a053ea497F295f855B2dC3580f517"//initial deploy
let wethOracleAddress: string
let usdcOracleAddress: string
let router02: string
let pool: string
let wethAddress: string
let usdcAddress: string
let wethFeedAddr: string
let usdcFeedAddr: string


let mainnet = true
let trigger: AutomatedTriggerSwap

//SET THIS FOR TESTING
const testingNetwork = "arbitrum"

let masterKeeper: MasterKeeper
async function main() {
  console.log("STARTING")
  let networkName = hre.network.name
  console.log(networkName)

  if (networkName == "hardhat" || networkName == "localhost") {
    networkName = testingNetwork
    mainnet = false
    console.log("Testing on network : ", networkName)

  } else {
    console.log("Deploying for real to: ", networkName)
  }

  if (networkName == "op") {
    if (!mainnet) {
      await resetCurrentOP()
      console.log("Testing on OP @", (await currentBlock())?.number)
    }

    triggerAddr = o.triggerAddress
    wethOracleAddress = o.wethOracleAddress
    usdcOracleAddress = o.usdcOracleAddress
    router02 = o.uniRouter
    pool: o.wethUsdcPoolAddress
    wethAddress = o.wethAddress
    usdcAddress = o.nativeUsdcAddress
    wethFeedAddr = o.wethFeed
    usdcFeedAddr = o.usdcFeed


  }

  if (networkName == "arbitrum") {

    if (!mainnet) {
      await resetCurrentArb()
      console.log("Testing on ARB @", (await currentBlock())?.number)

    }

    triggerAddr = a.triggerAddress
    wethOracleAddress = a.wethOracleAddress
    usdcOracleAddress = a.usdcOracleAddress
    router02 = a.uniRouter
    pool: a.wethUsdcPoolAddress
    wethAddress = a.wethAddress
    usdcAddress = a.nativeUsdcAddress
    wethFeedAddr = a.wethFeed
    usdcFeedAddr = a.usdcFeed
  }

  const [user] = await ethers.getSigners()


  //await deploy(user)
  //await deployOracles(user)
  await registerNewPair(user)
  //await setup(user)
  //await createOrder(user)
  //await createInvertedOrder(user)
  //await checkUpkeep(user)


  console.log("DONE")
}

const deploy = async (signer: Signer) => {

  if (!mainnet) {
    signer = await ethers.getSigner("0x085909388fc0cE9E5761ac8608aF8f2F52cb8B89")

    //testing does not scale tx cost correctly 
    await setBalance(await signer.getAddress(), ethers.parseEther("1"))
    await impersonateAccount(await signer.getAddress())

  }

  trigger = await DeployContract(new AutomatedTriggerSwap__factory(signer), signer)
  triggerAddr = await trigger.getAddress()
  console.log("DEPLOYED TRIGGER: ", await trigger.getAddress())

  if (mainnet) {
    console.log("Verifying...")
    await hre.run("verify:verify", {
      address: await trigger.getAddress()
    })
    console.log("verified")
  }

}

const deployOracles = async (signer: Signer) => {

  const wethOracle: IOracleRelay = await DeployContract(new OracleRelay__factory(signer), signer, wethAddress, wethFeedAddr)
  wethOracleAddress = await wethOracle.getAddress()
  console.log("DEPLOYED ETH ORACLE: ", await wethOracle.getAddress())
  console.log("WETH: ", ethers.formatUnits((await wethOracle.currentValue()).toString(), 8))

  const usdcOracle: IOracleRelay = await DeployContract(new OracleRelay__factory(signer), signer, usdcAddress, usdcFeedAddr)
  usdcOracleAddress = await usdcOracle.getAddress()
  console.log("DEPLOYED USDC ORACLE: ", await usdcOracle.getAddress())
  console.log("USDC: ", ethers.formatUnits((await usdcOracle.currentValue()).toString(), 8))


  if (mainnet) {
    console.log("Verifying...")
    await hre.run("verify:verify", {
      address: await wethOracle.getAddress(),
      constructorArguments: [
        wethAddress,
        wethFeedAddr
      ]
    })
    console.log("verified")
  }

}

const registerNewPair = async (signer: Signer) => {
  /**
   * Logic for pair order - most standard measure of value comes second
   * token / usd pairs have token as 0 and usd as 1
   * token / weth pairs have weth second
   * most standard measure of value comes second
   * if both are obscure - alphabetical by symbol
   */
  const wbtcAddress = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f"
  //const wstethAddress = "0x5979D7b546E38E414F7E9822514be443A4800529"//todo only has cl price against eth
  const arbAddress = "0x912CE59144191C1204E64559FE8253a0e49E6548"
  const usdtAddress = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"
  const token0s = [
    wbtcAddress,//1
    wbtcAddress,//2
    wethAddress,//3
    arbAddress//4
  ]
  const token1s = [
    wethAddress,
    usdcAddress,
    usdtAddress,
    wethAddress
  ]


  /**
  //deploy oracles
  //wbtcOracle
  const wbtcFeedAddress = "0xd0C7101eACbB49F3deCcCc166d238410D6D46d57"
  const wbtcOracle: IOracleRelay = await DeployContract(new OracleRelay__factory(signer), signer, wbtcAddress, wbtcFeedAddress)
  console.log("DEPLOYED WBTC ORACLE: ", await wbtcOracle.getAddress())
  console.log("WBTC: ", ethers.formatUnits((await wbtcOracle.currentValue()).toString(), 8))

  //arbOracle
  const arbFeedAddress = "0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6"
  const arbOracle: IOracleRelay = await DeployContract(new OracleRelay__factory(signer), signer, arbAddress, arbFeedAddress)
  console.log("DEPLOYED ARB ORACLE: ", await arbOracle.getAddress())
  console.log("ARB: ", ethers.formatUnits((await arbOracle.currentValue()).toString(), 8))

  //usdtOracle
  const usdtFeedAddress = "0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7"
  const usdtOracle: IOracleRelay = await DeployContract(new OracleRelay__factory(signer), signer, usdtAddress, usdtFeedAddress)
  console.log("DEPLOYED USDT ORACLE: ", await usdtOracle.getAddress())
  console.log("USDT: ", ethers.formatUnits((await usdtOracle.currentValue()).toString(), 8))

   */

  const wbtcOracleAddress = "0x17B7bD832666Ac28A6Ad35a93d4efF4eB9A07a17"
  const arbOracleAddress = "0x47CBd328B185Ea8fC61Ead9a32d0edd79067b577"
  const usdtOracleAddress = "0x0E2a18163e6cB2eB11568Fad35E42dE4EE67EA9a"

  trigger = AutomatedTriggerSwap__factory.connect(triggerAddr, signer)
  if (!mainnet) {
    signer = await ethers.getSigner("0x085909388fc0cE9E5761ac8608aF8f2F52cb8B89")

    //testing does not scale tx cost correctly 
    await setBalance(await signer.getAddress(), ethers.parseEther("1"))
    await impersonateAccount(await signer.getAddress())

  }

  //register oracles
  const tokens = [wbtcAddress, arbAddress, usdtAddress]
  const oracles = [wbtcOracleAddress, arbOracleAddress, usdtOracleAddress]
  const registerO = await trigger.connect(signer).registerOracle(tokens, oracles)
  await registerO.wait()
  console.log("REGISTERED ORACLES")

  //register pairs
  await trigger.connect(signer).registerPair(token0s, token1s)
  console.log("REGISTERED PAIRS")

}

const setup = async (signer: Signer) => {

  trigger = AutomatedTriggerSwap__factory.connect(triggerAddr, signer)

  if (!mainnet) {
    signer = await ethers.getSigner("0x085909388fc0cE9E5761ac8608aF8f2F52cb8B89")

    //testing does not scale tx cost correctly 
    await setBalance(await signer.getAddress(), ethers.parseEther("1"))
    await impersonateAccount(await signer.getAddress())

  }

  //register oracles
  const tokens = [wethAddress, usdcAddress]
  const oracles = [wethOracleAddress, usdcOracleAddress]
  await trigger.connect(signer).registerOracle(tokens, oracles)
  console.log("REGISTERED ORACLES")

  await trigger.connect(signer).setMaxPendingOrders(25)
  console.log("SET MAX PENDING ORDERS")

  await trigger.connect(signer).setMinOrderSize(ethers.parseUnits("0.5", 8))
  console.log("SET MIN ORDER SIZE")


  const token0s = [wethAddress]
  const token1s = [usdcAddress]
  await trigger.connect(signer).registerPair(token0s, token1s)
  console.log("SET PAIR")

  //console.log("CURRENT EXCHANGE RATE: ", ethers.formatUnits((await trigger.getExchangeRate(0)), 8))


}

const createOrder = async (signer: Signer) => {
  trigger = AutomatedTriggerSwap__factory.connect(triggerAddr, signer)
  const WETH = IERC20__factory.connect(wethAddress, signer)
  const USDC = IERC20__factory.connect(usdcAddress, signer)
  if (!mainnet) {
    signer = await ethers.getSigner("0x085909388fc0cE9E5761ac8608aF8f2F52cb8B89")

    //testing does not scale tx cost correctly 
    await setBalance(await signer.getAddress(), ethers.parseEther("1"))
    await impersonateAccount(await signer.getAddress())
  }

  const wethAmount = ethers.parseEther("0.0002")
  const strikeDelta = -1

  const exchangeRate = await trigger.getExchangeRate(0)
  const strikePrice = await getStrikePrice(exchangeRate, strikeDelta, false)

  await WETH.connect(signer).approve(await trigger.getAddress(), wethAmount)

  await trigger.connect(signer).createOrder(
    strikePrice,
    wethAmount,
    0,
    500,
    true
  )

  if (!mainnet) {
    const filter = trigger.filters.OrderCreated
    const events = await trigger.queryFilter(filter, -1)
    const event = events[0].args
    console.log("ORDER CREATED: ", Number(event[0]))
  }


}

const createInvertedOrder = async (signer: Signer) => {
  trigger = AutomatedTriggerSwap__factory.connect(triggerAddr, signer)
  const WETH = IERC20__factory.connect(wethAddress, signer)
  const USDC = IERC20__factory.connect(usdcAddress, signer)
  if (!mainnet) {
    signer = await ethers.getSigner("0x085909388fc0cE9E5761ac8608aF8f2F52cb8B89")

    //testing does not scale tx cost correctly 
    await setBalance(await signer.getAddress(), ethers.parseEther("1"))
    await impersonateAccount(await signer.getAddress())
  }

  const usdcAmount = ethers.parseUnits("0.51", 6)
  const strikeDelta = 1

  const exchangeRate = await trigger.getExchangeRate(0)
  const strikePrice = await getStrikePrice(exchangeRate, strikeDelta, false)

  await USDC.connect(signer).approve(await trigger.getAddress(), usdcAmount)

  await trigger.connect(signer).createOrder(
    strikePrice,
    usdcAmount,
    0,
    500,
    false
  )

  if (!mainnet) {
    const filter = trigger.filters.OrderCreated
    const events = await trigger.queryFilter(filter, -1)
    const event = events[0].args
    console.log("ORDER CREATED: ", Number(event[0]))
  }


}

const checkUpkeep = async (signer: Signer) => {
  console.log("CHECKING UPKEEP")

  //this block requires upkeep
  const UniPool = UniswapV3Pool__factory.connect(pool, signer)

  trigger = AutomatedTriggerSwap__factory.connect(triggerAddr, signer)
  const WETH = IERC20__factory.connect(wethAddress, signer)
  const USDC = IERC20__factory.connect(usdcAddress, signer)
  if (!mainnet) {
    console.log("Reset to OP")
    await resetCurrentOP()

    signer = await ethers.getSigner("0x085909388fc0cE9E5761ac8608aF8f2F52cb8B89")

    //testing does not scale tx cost correctly 
    await setBalance(await signer.getAddress(), ethers.parseEther("1"))
    await impersonateAccount(await signer.getAddress())
  }
  console.log("Checking....")
  const result = await trigger.checkUpkeep("0x")
  if (result.upkeepNeeded) {
    console.log("UPKEEP NEEDED")
    const decoded = await decodeUpkeepData(result.performData)
    const encodedTxData = await generateUniTx(
      router02,
      decoded.pendingOrderIdx,
      router02,
      UniPool,
      WETH,
      await USDC.getAddress(),
      await trigger.getAddress(),
      BigInt(decoded.order.amountIn.toString()),
      await trigger.getMinAmountReceived(0, true, BigInt(decoded.order.slippageBips.toString()), BigInt(decoded.order.amountIn.toString()))
    )
    console.log("PERFORMING")
    await trigger.performUpkeep(encodedTxData)
  }



}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })



