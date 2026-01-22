# TODO

## Buyback / Buy List Feature

Allow customers to sell cards to Runic Vault. Shop purchases cards at 70% of retail value when inventory is low (< 20 units).

### New Tools (3)

- [x] `get_buyback_offer` - Check if Runic Vault is buying a card
  - Input: `productHandle` or `variantId`
  - Check current inventory via Shopify
  - If `quantityAvailable < 20`: Return offer at 70% of retail price
  - If `quantityAvailable >= 20`: "Runic Vault is not currently purchasing this card"
  - Response should say "Runic Vault will purchase this card at $X (70% of retail $Y)"

- [x] `submit_to_buylist` - Submit a sell request for shop approval
  - Input: `variantId`, `sellerUnicityId`, `quantity`
  - Validate offer still valid (re-check inventory)
  - Create pending buy list request
  - Return: request ID, status "pending approval"
  - Message: "Submitted to Runic Vault's buy list. Request #ID pending approval."

- [x] `check_buylist_status` - Check status of a buy list submission
  - Input: `requestId`
  - Return current status: `pending` | `approved` | `rejected`
  - If approved: "Approved - awaiting shipping details"
  - If pending: "Pending approval from Runic Vault"
  - If rejected: "Runic Vault declined this purchase"

### Data Model

```typescript
interface BuylistRequest {
  id: string;                    // UUID
  variantId: string;             // Shopify variant GID
  productHandle: string;
  productTitle: string;
  variantTitle: string;
  quantity: number;
  offerPriceCents: number;       // 70% of retail
  retailPriceCents: number;      // Original price
  currency: string;              // AED
  sellerUnicityId: string;       // Customer's Unicity ID
  status: 'pending' | 'approved' | 'rejected';
  createdAt: Date;
  updatedAt: Date;
}
```

### Storage

- [x] Create `src/store/buylist.ts` - In-memory Map<string, BuylistRequest>
- [x] Add helper functions: `createRequest`, `getRequest`, `updateStatus`, `getRequestsBySeller`

### Files to Create/Modify

- [x] `src/types.ts` - Add `BuylistRequest` interface
- [x] `src/store/buylist.ts` - Buy list storage (new file)
- [x] `src/store/index.ts` - Export buy list store
- [x] `src/tools/buylist.ts` - Tool implementations (new file)
- [x] `src/tools/index.ts` - Register new tools
- [x] `CLAUDE.md` - Update tool count (9 → 12) and add tool descriptions

### Out of Scope (Future)

- Shipping instructions / label generation
- Actual payment execution (shop → customer)
- Admin approval interface (done externally for now)
- Persistence (in-memory only, like carts)

### Testing

- [ ] Test: Card with low inventory (< 20) returns 70% offer
- [ ] Test: Card with high inventory (>= 20) returns "not buying"
- [ ] Test: Submit to buy list creates pending request
- [ ] Test: Check status returns correct state
- [ ] Test: Invalid product/variant returns error
- [ ] Test: Exact price calculations (no approximations)
