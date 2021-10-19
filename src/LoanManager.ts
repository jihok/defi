import { ethers } from "ethers";
import { BigNumber } from "@ethersproject/bignumber";
import LENDING_POOL_PROXY_ABI from "../abis/LendingPoolProxy.json";
import RESERVE_GAUGE_ABI from "../abis/ReserveGauge.json";
import RESERVE_POOL_ABI from "../abis/ReservePool.json";
import RESERVE_TOKEN_ABI from "../abis/ReserveToken.json";
import USDC_ABI from "../abis/USDC.json";

const {
  MY_WALLET_ADDRESS,
  RPC_PROVIDER,
  ETHERSCAN_API_KEY,
  NETWORK,
  PRIVATE_KEY,
} = process.env;
const PROVIDER = new ethers.providers.JsonRpcProvider(RPC_PROVIDER);
const WALLET = new ethers.Wallet(PRIVATE_KEY, PROVIDER);
const MIN_GAS = ethers.utils.parseUnits("30", "gwei");

// AAVE
const LENDING_POOL_ADDRESS = "0x8dFf5E27EA6b7AC08EbFdf9eB090F32ee9a30fcf";
const USDC_ADDRESS = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const SAFE_HEALTH_FACTOR = ethers.utils.parseEther("1.5");

// CURVE
const STABLE_RESERVE = {
  gauge: "0x19793B454D3AfC7b454F206Ffe95aDE26cA6912c",
  pool: "0x445FE580eF8d70FF569aB36e80c647af338db351",
  token: "0xE7a24EF0C5e95Ffb0f6684b813A78F2a3AD7D171",
};
const USDC_ID = 1;

// TODO: Future implementations should have multiple price providers for redundancy
const getEthPriceUSD = async () => {
  try {
    const scanProvider = new ethers.providers.EtherscanProvider(
      NETWORK,
      ETHERSCAN_API_KEY
    );
    return await scanProvider.getEtherPrice();
  } catch (e) {
    console.error(e);
  }
};

interface UserAccountData {
  healthFactor: BigNumber;
  totalCollateralETH: BigNumber;
  currentLiquidationThreshold: BigNumber;
  totalDebtETH: BigNumber;
}

const getUserLoanData = async (): Promise<UserAccountData> => {
  try {
    const lendingPoolContract = new ethers.Contract(
      LENDING_POOL_ADDRESS,
      LENDING_POOL_PROXY_ABI,
      PROVIDER
    );
    return await lendingPoolContract.getUserAccountData(MY_WALLET_ADDRESS);
  } catch (e) {
    console.error(e);
  }
};

interface ReserveBalance {
  gaugeBalance: BigNumber;
  stableBalanceETH: BigNumber;
}

const getStableReserveBalances = async (
  ethPriceUSD: number
): Promise<ReserveBalance> => {
  try {
    const reserveGaugeContract = new ethers.Contract(
      STABLE_RESERVE.gauge,
      RESERVE_GAUGE_ABI,
      PROVIDER
    );
    const reservePoolContract = new ethers.Contract(
      STABLE_RESERVE.pool,
      RESERVE_POOL_ABI,
      PROVIDER
    );
    const gaugeBalance = await reserveGaugeContract.balanceOf(
      MY_WALLET_ADDRESS
    );
    const virtualPrice: BigNumber =
      await reservePoolContract.get_virtual_price();
    const stableBalanceUSD = gaugeBalance.mul(virtualPrice);
    const stableBalanceETH = stableBalanceUSD.div(
      ethers.utils.parseUnits(`${ethPriceUSD}`)
    );
    return { gaugeBalance, stableBalanceETH };
  } catch (e) {
    console.error(e);
  }
};

interface WithdrawOpts {
  amountUnstaked: BigNumber;
  minWithdrawAmount: BigNumber;
}

const getWithdrawOpts = async (
  withdrawCoin = USDC_ID
): Promise<WithdrawOpts> => {
  try {
    const reserveTokenContract = new ethers.Contract(
      STABLE_RESERVE.token,
      RESERVE_TOKEN_ABI,
      PROVIDER
    );
    const reservePoolContract = new ethers.Contract(
      STABLE_RESERVE.pool,
      RESERVE_POOL_ABI,
      PROVIDER
    );
    const amountUnstaked = await reserveTokenContract.balanceOf(
      MY_WALLET_ADDRESS
    );
    const minWithdrawAmount = await reservePoolContract.calc_withdraw_one_coin(
      amountUnstaked,
      withdrawCoin
    );
    return { amountUnstaked, minWithdrawAmount };
  } catch (e) {
    console.error(e);
  }
};

interface RemoveLiquidityParams {
  unstakeAmount: BigNumber;
  withdrawCoin?: number;
  useUnderlying: boolean;
}

const withdrawFromReserve = async ({
  unstakeAmount,
  withdrawCoin = USDC_ID,
  useUnderlying,
}: RemoveLiquidityParams) => {
  try {
    const reserveGaugeContract = new ethers.Contract(
      STABLE_RESERVE.gauge,
      RESERVE_GAUGE_ABI,
      WALLET
    );
    const reservePoolContract = new ethers.Contract(
      STABLE_RESERVE.pool,
      RESERVE_POOL_ABI,
      WALLET
    );

    // overloaded functions in the ABI can be removed for cleaner code here
    const gaugeUnstakeTx: ethers.providers.TransactionResponse =
      await reserveGaugeContract["withdraw(uint256)"](unstakeAmount, {
        gasLimit: 294771, // the estimate is inaccurate and leads to out-of-gas errors
        gasPrice: MIN_GAS, // allow the provider to estimate gasPrice in times of network congestion
      });
    await gaugeUnstakeTx.wait();

    const { amountUnstaked, minWithdrawAmount } = await getWithdrawOpts(
      USDC_ID
    );
    const removeOneCoinTx = await reservePoolContract[
      "remove_liquidity_one_coin(uint256,int128,uint256,bool)"
    ](amountUnstaked, withdrawCoin, minWithdrawAmount, useUnderlying, {
      gasLimit: 1494483,
      gasPrice: MIN_GAS,
    });
    await removeOneCoinTx.wait();
  } catch (e) {
    console.error(e);
  }
};

const repayDebt = async () => {
  try {
    const lendingPoolContract = new ethers.Contract(
      LENDING_POOL_ADDRESS,
      LENDING_POOL_PROXY_ABI,
      WALLET
    );
    const usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, PROVIDER);
    const usdcBalance = await usdcContract.balanceOf(MY_WALLET_ADDRESS);
    const rateMode = 2; // variable debt
    const repayTx: ethers.providers.TransactionResponse =
      await lendingPoolContract.repay(
        USDC_ADDRESS,
        usdcBalance,
        rateMode,
        MY_WALLET_ADDRESS
      );

    repayTx.wait();
  } catch (e) {
    console.error(e);
  }
};

/**
 * 1. Check if we can fold the stable reserve onto the existing CDP because we're greedy and prefer to farm MATIC.
 * 2. If folding doesn't take us to our desired health factor, repay as much of the loan as we can through the reserve.
 */
export const manageLoan = async () => {
  const ethPriceUSD = await getEthPriceUSD();
  const {
    healthFactor,
    totalCollateralETH,
    currentLiquidationThreshold,
    totalDebtETH,
  } = await getUserLoanData();
  const { gaugeBalance, stableBalanceETH } = await getStableReserveBalances(
    ethPriceUSD
  );

  if (healthFactor.lt(SAFE_HEALTH_FACTOR)) {
    // collateral and debt values are 18 digits, but currentLiquidationThreshold is only 4 digits
    const adjustedLiquidationThreshold = currentLiquidationThreshold.mul(
      BigNumber.from("10").pow(14)
    );
    const targetStableFoldETH = SAFE_HEALTH_FACTOR.mul(totalDebtETH)
      .div(adjustedLiquidationThreshold)
      .sub(totalCollateralETH);

    if (stableBalanceETH.gte(targetStableFoldETH)) {
      const unstakePercent = targetStableFoldETH
        .mul(BigNumber.from("10").pow(18))
        .div(stableBalanceETH);
      const foldAmount = unstakePercent
        .mul(gaugeBalance)
        .div(BigNumber.from("10").pow(18));

      await withdrawFromReserve({
        unstakeAmount: foldAmount,
        useUnderlying: false,
      });
    } else {
      const debtForSafeHF = totalCollateralETH
        .mul(adjustedLiquidationThreshold)
        .div(SAFE_HEALTH_FACTOR);
      const targetRepayETH = totalDebtETH.sub(debtForSafeHF);
      const unstakePercent = targetRepayETH
        .mul(BigNumber.from("10").pow(18))
        .div(stableBalanceETH);

      // the most we can withdraw is 100%, or the gaugeBalance
      const unstakeAmount = unstakePercent.gt(BigNumber.from("10").pow(18))
        ? gaugeBalance
        : unstakePercent.mul(gaugeBalance).div(BigNumber.from("10").pow(18));

      await withdrawFromReserve({
        unstakeAmount,
        useUnderlying: true,
      });

      await repayDebt();
    }
  }
};
