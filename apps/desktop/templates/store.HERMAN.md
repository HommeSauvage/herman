---
version: 1
extends: base
name: Store
description: A simple online shop where you can list products and let visitors add them to a cart. Think of it like a digital catalog where people can browse what you sell.
suitable_for: Great if you sell physical or digital products online and want a simple catalog with a cart, without needing a complex marketplace.
icon: "🏪"
category: commerce
---

## Setup
- Turn this starter into a simple online store. Remove Restate, campaigns, todos, and other non-essential functionality. Auth is necessary for the store owner; customers may browse as guests or sign in depending on what the user wants.
- Create the database structure for commerce: products, categories (if useful), cart items, and orders. Include fields for name, description, price, images, and stock quantity if inventory tracking is requested.
- Build the storefront UI: product listing grid, product detail page, cart sidebar or page, and a checkout flow. Mimic the clarity of Shopify or Gumroad product pages — large images, clear pricing, and an obvious "Add to cart" action.
- Keep checkout simple: collect shipping address only if physical products are involved; skip payment integration unless the user asked for it now (show a placeholder or "contact to order" step instead).

## Admin
- Change the dashboard to show store statistics: total orders, revenue (if payments exist), low-stock alerts, and recent orders.
- Add full product CRUD in the admin: create, edit, archive products with title, description, price, images (upload or URL), and optional variants (size, color, etc.).
- Add an orders view with status workflow: pending, paid, shipped, cancelled. Let the admin update status and add an internal note per order.
- For categories, allow the admin to search and create categories from a combobox input (use shadcn registries for a searchable select, or react-select).
- If inventory is enabled, show stock count on the product edit form and surface low-stock warnings on the dashboard home.

## Questions
- Ask the user what the store sells.
- Ask who the customers are and whether products are physical, digital, or both.
- Ask whether they need payments integrated now or just a product catalog with a cart for later.
- Ask about product variants: single SKU per product, or options like size and color.
- Ask whether they need shipping address collection and inventory tracking.

## Guidance
This is a commerce project. Prefer clear product pages and a simple cart experience.
Do not force payment provider setup unless the user wants it.
