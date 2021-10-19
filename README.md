# About

A set of Node scripts written in Typescript to automate Defi actions.

## manageLoan

Helps maintain a healthy health factor on Aave's Polygon market with funds pooled in Curve's aToken pool. If the user's health factor dips below their desired health factor, the manager first checks if it can simply withdraw the aTokens from Curve to maximize MATIC farming (at least while that is still active). If folding the stablecoins into collateral isn't enough, the manager will repay as much as needed up to the total balance available in the Curve pool.

For this to be truly helpful, it should be called frequently either via scheduled serverless function calls or on a loop on an always-on machine. 
