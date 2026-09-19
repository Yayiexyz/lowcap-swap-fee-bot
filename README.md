# LowCap Swap Fee Bot v4.1 Hosted Pro

Base / Uniswap v3 WETH-USDC concentrated-liquidity helper.

- Network: Base
- Pair: WETH/USDC
- Fee tier: fixed 0.30%
- Range: fixed ±3%
- Phantom approvals required for on-chain transactions
- No private key stored in the site

## v4.1 upgrades
- 30-second confirmed OUT-OF-RANGE trigger before auto-recenter
- ~$2.50 native ETH gas-reserve guard
- 10-minute post-rebalance churn guard
- Optional browser notifications
- Optional Screen Wake Lock
- Vercel-ready static deployment
- Auto-reconnect Phantom after the site has already been authorized

The LP itself continues earning on-chain when the dashboard is closed. Browser-side monitoring and auto-rebalance logic still require a running browser session.
