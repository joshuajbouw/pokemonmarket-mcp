/**
 * Unit tests for cart store
 *
 * Tests must be EXACT, not approximations.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createCart,
  getCart,
  addToCart,
  removeFromCart,
  clearCart,
  recalculateCart,
  clearAllCarts,
} from "../../src/store/cart.js";
import type { Cart } from "../../src/types.js";
import { getFixtureProducts, getMultiVariantProduct, getOutOfStockProduct } from "../mocks/shopify.js";

describe("Cart Store", () => {
  beforeEach(() => {
    clearAllCarts();
  });

  describe("createCart", () => {
    it("returns cart with exact structure", () => {
      const cart = createCart();

      expect(cart).toHaveProperty("id");
      expect(typeof cart.id).toBe("string");
      expect(cart.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(cart.lines).toEqual([]);
      expect(cart.subtotalCents).toBe(0);
      expect(cart.currency).toBe("AED");
      expect(cart.createdAt).toBeInstanceOf(Date);
      expect(cart.updatedAt).toBeInstanceOf(Date);
      expect(cart.lockedForCheckout).toBeUndefined();
    });

    it("creates unique cart IDs", () => {
      const cart1 = createCart();
      const cart2 = createCart();
      const cart3 = createCart();

      expect(cart1.id).not.toBe(cart2.id);
      expect(cart2.id).not.toBe(cart3.id);
      expect(cart1.id).not.toBe(cart3.id);
    });
  });

  describe("getCart", () => {
    it("returns null for non-existent cart", () => {
      const result = getCart("non-existent-cart-id");
      expect(result).toBeNull();
    });

    it("returns cart for valid cart ID", () => {
      const created = createCart();
      const retrieved = getCart(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
    });
  });

  describe("addToCart", () => {
    it("with quantity 1 → exact line item", () => {
      const cart = createCart();
      const products = getFixtureProducts();
      const product = products[0]; // Elder Futhark Rune Set
      const variant = product.variants.edges[0].node;

      const result = addToCart(cart.id, product, variant, 1);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.cart.lines).toHaveLength(1);
        expect(result.cart.lines[0].variantId).toBe(
          "gid://shopify/ProductVariant/44001234567890"
        );
        expect(result.cart.lines[0].productTitle).toBe("Elder Futhark Rune Set");
        expect(result.cart.lines[0].variantTitle).toBe("Default Title");
        expect(result.cart.lines[0].quantity).toBe(1);
        expect(result.cart.lines[0].unitPriceCents).toBe(4999);
        expect(result.cart.lines[0].lineTotalCents).toBe(4999);
        expect(result.cart.lines[0].currency).toBe("USD");
        expect(result.cart.subtotalCents).toBe(4999);
      }
    });

    it("same variant twice → quantity increases exactly", () => {
      const cart = createCart();
      const products = getFixtureProducts();
      const product = products[0];
      const variant = product.variants.edges[0].node;

      addToCart(cart.id, product, variant, 1);
      const result = addToCart(cart.id, product, variant, 2);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.cart.lines).toHaveLength(1);
        expect(result.cart.lines[0].quantity).toBe(3);
        expect(result.cart.lines[0].lineTotalCents).toBe(14997);
        expect(result.cart.subtotalCents).toBe(14997);
      }
    });

    it("different variants → two line items", () => {
      const cart = createCart();
      const multiVariantProduct = getMultiVariantProduct(); // Runic Divination Kit
      const variant1 = multiVariantProduct.variants.edges[0].node; // Standard $79.99
      const variant2 = multiVariantProduct.variants.edges[1].node; // Deluxe $99.99

      addToCart(cart.id, multiVariantProduct, variant1, 1);
      const result = addToCart(cart.id, multiVariantProduct, variant2, 1);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.cart.lines).toHaveLength(2);
        expect(result.cart.lines[0].variantId).toBe(
          "gid://shopify/ProductVariant/44001234567891"
        );
        expect(result.cart.lines[0].variantTitle).toBe("Standard");
        expect(result.cart.lines[0].unitPriceCents).toBe(7999);
        expect(result.cart.lines[1].variantId).toBe(
          "gid://shopify/ProductVariant/44001234567892"
        );
        expect(result.cart.lines[1].variantTitle).toBe("Deluxe");
        expect(result.cart.lines[1].unitPriceCents).toBe(9999);
        expect(result.cart.subtotalCents).toBe(17998);
      }
    });

    it("invalid cartId → exact error message", () => {
      const products = getFixtureProducts();
      const product = products[0];
      const variant = product.variants.edges[0].node;

      const result = addToCart("invalid-cart-id", product, variant, 1);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("cart_not_found");
        expect(result.message).toBe("Cart not found");
      }
    });
  });

  describe("removeFromCart", () => {
    it("removes item → exact remaining items", () => {
      const cart = createCart();
      const products = getFixtureProducts();
      const product1 = products[0]; // Elder Futhark Rune Set $49.99
      const product2 = products[2]; // Viking Compass Pendant $149.99
      const variant1 = product1.variants.edges[0].node;
      const variant2 = product2.variants.edges[0].node;

      addToCart(cart.id, product1, variant1, 1);
      addToCart(cart.id, product2, variant2, 1);

      const lineId = cart.lines[0].id;
      const result = removeFromCart(cart.id, lineId);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.cart.lines).toHaveLength(1);
        expect(result.cart.lines[0].productTitle).toBe("Viking Compass Pendant");
        expect(result.cart.subtotalCents).toBe(14999);
      }
    });

    it("invalid cartId → exact error message", () => {
      const result = removeFromCart("invalid-cart-id", "some-line-id");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("cart_not_found");
        expect(result.message).toBe("Cart not found");
      }
    });

    it("invalid lineId → exact error message", () => {
      const cart = createCart();
      const result = removeFromCart(cart.id, "invalid-line-id");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("line_not_found");
        expect(result.message).toBe("Line item not found in cart");
      }
    });
  });

  describe("recalculateCart", () => {
    it("calculates exact total (e.g., 149.99, not ~150)", () => {
      const cart = createCart();
      const products = getFixtureProducts();

      // Add Elder Futhark Rune Set ($49.99) x2
      const product1 = products[0];
      const variant1 = product1.variants.edges[0].node;
      addToCart(cart.id, product1, variant1, 2);

      // Add Viking Compass Pendant ($149.99) x1
      const product2 = products[2];
      const variant2 = product2.variants.edges[0].node;
      addToCart(cart.id, product2, variant2, 1);

      const updatedCart = getCart(cart.id)!;

      // $49.99 * 2 + $149.99 = $249.97
      expect(updatedCart.subtotalCents).toBe(24997);
      expect(updatedCart.lines[0].lineTotalCents).toBe(9998);
      expect(updatedCart.lines[1].lineTotalCents).toBe(14999);
    });

    it("recalculates after modification", () => {
      const cart = createCart();
      const products = getFixtureProducts();
      const product = products[0];
      const variant = product.variants.edges[0].node;

      addToCart(cart.id, product, variant, 3);
      expect(cart.subtotalCents).toBe(14997);

      // Manually modify and recalculate
      cart.lines[0].quantity = 5;
      cart.lines[0].lineTotalCents = cart.lines[0].unitPriceCents * 5;
      recalculateCart(cart);

      expect(cart.subtotalCents).toBe(24995);
    });
  });

  describe("clearCart", () => {
    it("empties cart completely", () => {
      const cart = createCart();
      const products = getFixtureProducts();
      const product = products[0];
      const variant = product.variants.edges[0].node;

      addToCart(cart.id, product, variant, 3);
      expect(cart.lines).toHaveLength(1);
      expect(cart.subtotalCents).toBe(14997);

      const cleared = clearCart(cart.id);

      expect(cleared).not.toBeNull();
      expect(cleared!.lines).toEqual([]);
      expect(cleared!.subtotalCents).toBe(0);
    });

    it("returns null for invalid cartId", () => {
      const result = clearCart("invalid-cart-id");
      expect(result).toBeNull();
    });
  });
});
