# Pokemon Market MCP Server

A TypeScript MCP (Model Context Protocol) server for Pokemon Markets like [Runic Vault]
(https://runic-vault.ae) - AI-assisted e-commerce with real Unicity token payments.

Built for Unicity Labs as a demo of conversational commerce.

## Overview

This server connects to the real Runic Vault Shopify store and enables:
- **Real products** from the Shopify Storefront API (with images)
- **Shopping cart** managed locally
- **Real Unicity payments** via Nostr protocol
- **Buyback / Buy list** - sell cards back to the shop at 70% retail

## Tools

| Tool | Description |
|------|-------------|
| `search_products` | Search products with images |
| `get_product` | Full product details with image |
| `check_inventory` | Check variant stock status |
| `create_cart` | Create new shopping cart |
| `add_to_cart` | Add items to cart |
| `get_cart` | View cart contents |
| `remove_from_cart` | Remove item from cart |
| `checkout_with_unicity` | Initiate Unicity payment |
| `confirm_payment` | Wait for and confirm payment |
| `get_buyback_offer` | Check if shop is buying a card (70% of retail) |
| `submit_to_buylist` | Submit sell request for shop approval |
| `check_buylist_status` | Check status of buy list submission |

## Prerequisites

- Node.js 18+
- Shopify Storefront API token for runic-vault.ae
- Unicity testnet credentials (nametag, coin ID)

## Installation

```bash
npm install
cp .env.example .env
# Edit .env with your credentials
```

## Configuration

```bash
# Shopify (required)
SHOPIFY_STORE_DOMAIN=runic-vault.ae
SHOPIFY_STOREFRONT_TOKEN=your_token

# Unicity (required)
MCP_NAMETAG=runic-vault
PAYMENT_COIN_ID=your_coin_id

# Unicity (optional)
NOSTR_RELAY_URL=wss://nostr-relay.testnet.unicity.network
AGGREGATOR_URL=https://goggregator-test.unicity.network
PAYMENT_TIMEOUT_SECONDS=120
DATA_DIR=./data
```

## Usage

### Development
```bash
npm run dev    # Hot reload
npm run build  # Compile
npm start      # Production
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "runic-vault": {
      "command": "node",
      "args": ["/path/to/dist/index.js"],
      "env": {
        "SHOPIFY_STORE_DOMAIN": "runic-vault.ae",
        "SHOPIFY_STOREFRONT_TOKEN": "your_token",
        "MCP_NAMETAG": "runic-vault",
        "PAYMENT_COIN_ID": "your_coin_id"
      }
    }
  }
}
```

## Payment Flow

```
1. User: "I'd like to checkout with Unicity"
   → Provides their Unicity ID (e.g., @alice)

2. checkout_with_unicity(cartId, unicityId)
   → Returns: amount in tokens, payment address, event ID

3. User sends tokens via Unicity wallet

4. User: "Confirm my payment"

5. confirm_payment(cartId)
   → Waits for payment (up to 120s)
   → Returns: success or timeout
```

## Buyback / Buy List

Customers can sell cards back to Runic Vault at 70% of retail when inventory is low.

```
1. User: "Do you buy Pokemon cards?"

2. get_buyback_offer(productHandle or variantId)
   → If inventory < 20: Returns offer at 70% of retail
   → If inventory >= 20: "Not currently purchasing"

3. User: "I'd like to sell my card"

4. submit_to_buylist(variantId, sellerUnicityId, quantity)
   → Creates pending request
   → Returns: request ID, offer amount

5. check_buylist_status(requestId)
   → Returns: pending | approved | rejected
```

## Project Structure

```
src/
├── index.ts          # Entry point
├── server.ts         # MCP server
├── config.ts         # Configuration
├── types.ts          # Shared types
├── shopify/          # Shopify API client
├── store/            # Local cart & buy list management
├── unicity/          # Payment integration
│   ├── identity.ts   # Key management
│   ├── nostr.ts      # Payment requests
│   └── payment-tracker.ts
└── tools/            # MCP tools
data/
├── identity.json     # Server identity (auto-generated)
└── tokens/           # Payment receipts
```

## License

MIT
