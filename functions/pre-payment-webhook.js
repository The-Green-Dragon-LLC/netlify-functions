const Airtable = require("airtable");
const FoxySDK = require("@foxy.io/sdk");
const {
  AIRTABLE_API_KEY,
  FOXY_REFRESH_TOKEN,
  FOXY_CLIENT_SECRET,
  FOXY_CLIENT_ID,
} = process.env;

// ─── Cross-sell promo validation ────────────────────────────────────────────
const CROSSELL_PROMO_CATEGORY       = "CROSSELL_PROMO";
const CROSSELL_DEFAULT_DISCOUNT_PCT = 40;   // used only when Airtable leaves the discount blank
const CROSSELL_PRICE_TOLERANCE      = 0.01;
const CROSSELL_PRODUCTS_TABLE       = "tblkLl9qqg654fWi7";
const CROSSELL_VARIANTS_TABLE       = "tblEtb1aIH5Xk4Nh9";
const CROSSELL_PRIMARY_CATS_TABLE   = "tbliSkVUbug2MYAW7"; // Primary Categories
const CROSSELL_GENERIC_TABLE        = "tblwkNLyvaTJaGgpD"; // Cross-Sells (generic)

/**
 * Builds a map of { [Foxy code]: { price, discountPct, maxQty } } for all
 * cross-sell products AND their variants.  Pricing may live at the variant
 * level (parent product has no Price), so we fetch both tables.
 *
 * The offer terms — products, discount %, and max qty — are read from the SAME
 * Airtable sources the popup uses (see crossell-config.js), so the validator
 * can never reject something the popup was allowed to offer:
 *   • Primary Categories → "Cross-sell Product" links, "Cross-sell Discount",
 *     "Cross-sell Max Qty"                              (category cross-sells)
 *   • active Cross-Sells → "Product" links, "Discount", "Max Qty"
 *                                                       (generic cross-sells)
 * No per-product checkbox is involved — linking a product as a cross-sell is
 * all that's required for it to validate at checkout.
 *
 * Airtable percent fields return decimal fractions (0.5 = 50% off), matching
 * how crossell-config.js normalises them.  A blank discount falls back to
 * CROSSELL_DEFAULT_DISCOUNT_PCT and a blank max qty means "no cap", which is
 * what the popup does (`effectiveMaxQty` → Infinity).
 *
 * When the same product is offered by more than one cross-sell row, the most
 * permissive terms win (largest discount, largest qty cap) so a legitimate
 * add from any one of those offers still validates.
 */
async function fetchCrossSellPriceMap(airtableBase) {
  const map = {};

  // 1. Collect cross-sell product record IDs plus each product's offer terms.
  //    terms: { [productRecordId]: { discountPct, maxQty } }
  const terms = {};

  const mergeTerms = (productId, discountPct, maxQty) => {
    const prev = terms[productId];
    if (!prev) {
      terms[productId] = { discountPct, maxQty };
      return;
    }
    // Most permissive wins: biggest discount, biggest cap (Infinity = no cap).
    prev.discountPct = Math.max(prev.discountPct, discountPct);
    prev.maxQty      = Math.max(prev.maxQty, maxQty);
  };

  await airtableBase(CROSSELL_PRIMARY_CATS_TABLE)
    .select({
      fields:          ["Cross-sell Product", "Cross-sell Discount", "Cross-sell Max Qty"],
      filterByFormula: "COUNTA({Cross-sell Product}) > 0",
    })
    .eachPage((records, fetchNextPage) => {
      records.forEach((r) => {
        const rawDiscount = r.get("Cross-sell Discount");   // null | 0.0–1.0
        const rawMaxQty   = r.get("Cross-sell Max Qty");    // null | integer
        const discountPct = rawDiscount != null
          ? Math.round(rawDiscount * 100)
          : CROSSELL_DEFAULT_DISCOUNT_PCT;
        const maxQty      = rawMaxQty != null ? rawMaxQty : Infinity;
        (r.get("Cross-sell Product") || []).forEach((id) =>
          mergeTerms(id, discountPct, maxQty)
        );
      });
      fetchNextPage();
    });

  await airtableBase(CROSSELL_GENERIC_TABLE)
    .select({
      fields:          ["Product", "Discount", "Max Qty"],
      filterByFormula: "{Active} = TRUE()",
    })
    .eachPage((records, fetchNextPage) => {
      records.forEach((r) => {
        const rawDiscount = r.get("Discount");   // null | 0.0–1.0
        const rawMaxQty   = r.get("Max Qty");    // null | integer
        const discountPct = rawDiscount != null
          ? Math.round(rawDiscount * 100)
          : CROSSELL_DEFAULT_DISCOUNT_PCT;
        const maxQty      = rawMaxQty != null ? rawMaxQty : Infinity;
        (r.get("Product") || []).forEach((id) =>
          mergeTerms(id, discountPct, maxQty)
        );
      });
      fetchNextPage();
    });

  const productIds = new Set(Object.keys(terms));
  if (productIds.size === 0) return map;

  // 2. Fetch those parent products: record any parent-level price + variant IDs.
  const parentIds     = [...productIds];
  const parentFormula = parentIds.length === 1
    ? `RECORD_ID() = "${parentIds[0]}"`
    : `OR(${parentIds.map((id) => `RECORD_ID() = "${id}"`).join(",")})`;

  const allVariantIds = [];
  const termsByVariantId = {};   // variants inherit their parent product's offer terms
  await airtableBase(CROSSELL_PRODUCTS_TABLE)
    .select({
      fields:          ["Website Product Code", "Price", "Variants"],
      filterByFormula: parentFormula,
    })
    .eachPage((records, fetchNextPage) => {
      records.forEach((r) => {
        const code  = r.get("Website Product Code");
        const price = r.get("Price");
        const t     = terms[r.id] || {
          discountPct: CROSSELL_DEFAULT_DISCOUNT_PCT,
          maxQty:      Infinity,
        };
        if (code && price) {
          map[code] = { price, discountPct: t.discountPct, maxQty: t.maxQty };
        }
        (r.get("Variants") || []).forEach((id) => {
          allVariantIds.push(id);          // collect variant IDs
          termsByVariantId[id] = t;        // and the terms they inherit
        });
      });
      fetchNextPage();
    });

  // 3. Fetch all variant prices for those products
  if (allVariantIds.length > 0) {
    const formula = allVariantIds.length === 1
      ? `RECORD_ID() = "${allVariantIds[0]}"`
      : `OR(${allVariantIds.map(id => `RECORD_ID() = "${id}"`).join(",")})`;

    await airtableBase(CROSSELL_VARIANTS_TABLE)
      .select({
        fields:          ["Website Product Code", "Price"],
        filterByFormula: formula,
      })
      .eachPage((records, fetchNextPage) => {
        records.forEach((r) => {
          const code  = r.get("Website Product Code");
          const price = r.get("Price");
          const t     = termsByVariantId[r.id] || {
            discountPct: CROSSELL_DEFAULT_DISCOUNT_PCT,
            maxQty:      Infinity,
          };
          if (code && price) {           // variant-level price
            map[code] = { price, discountPct: t.discountPct, maxQty: t.maxQty };
          }
        });
        fetchNextPage();
      });
  }

  return map;
}
// ────────────────────────────────────────────────────────────────────────────

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(
  "appWUsGD3byrYcN3l"
);

const productsTableId = "tblkLl9qqg654fWi7";
const variantsTableId = "tblEtb1aIH5Xk4Nh9";
const membershipsTableId = "tblrNW5UvoSVMUsYr";

const getProductInventory = async (productCode) => {
  const tableRecords = [];

  // find record in Products table
  await base(productsTableId)
    .select({
      filterByFormula: `{Website Product Code} = "${productCode}"`,
    })
    .eachPage(function page(records, fetchNextPage) {
      records.forEach((record) => {
        tableRecords.push({
          name: record.get("Name"),
          wpc: record.get("Website Product Code"),
          inventorySum: record.get("Inventory"),
          inventoryChesterfield: record.get("Inventory (Chesterfield)"),
          inventoryStPeters: record.get("Inventory (St Peters)"),
          inventoryWarehouse: record.get("Inventory (Warehouse)"),
          inStoreOnly: record.get("In-Store Only"),
        });
      });

      fetchNextPage();
    });

  if (tableRecords.length === 0) {
    // find record in Product Variants table
    await base(variantsTableId)
      .select({
        filterByFormula: `{Website Product Code} = "${productCode}"`,
      })
      .eachPage(function page(records, fetchNextPage) {
        records.forEach((record) => {
          tableRecords.push({
            name: record.get("Name"),
            wpc: record.get("Website Product Code"),
            inventorySum: record.get("Inventory"),
            inventoryChesterfield: record.get("Inventory (Chesterfield)"),
            inventoryStPeters: record.get("Inventory (St Peters)"),
            inventoryWarehouse: record.get("Inventory (Warehouse)"),
            inStoreOnly: record.get("In-Store Only"),
          });
        });

        fetchNextPage();
      });
  }

  return tableRecords;
};

const getMembershipPrice = async (membershipCode, subFrequency) => {
  const tableRecords = [];

  const frequencies = [
    {
      code: "1m",
      name: "Price (Monthly)",
    },
    {
      code: "3m",
      name: "Price (Quarterly)",
    },
    {
      code: "1y",
      name: "Price (Annually)",
    },
  ];

  const frequencyName = frequencies.find(
    (freq) => subFrequency === freq.code
  ).name;

  await base(membershipsTableId)
    .select({
      filterByFormula: `SKU = "${membershipCode}"`,
    })
    .eachPage(function page(records, fetchNextPage) {
      records.forEach((record) => {
        tableRecords.push({
          name: record.get("Name"),
          sku: record.get("SKU"),
          price: record.get(frequencyName),
        });
      });

      fetchNextPage();
    });

  return tableRecords;
};

/**
 * Stock validation for the whole cart, aggregated per product code.
 *
 * Returns an array of { type, value } shortfalls for the caller to file under the
 * right rejection message; an empty array means every product has the stock the
 * cart is asking for.
 *
 * TWO BUGS THIS FIXES, both of which let sold-out goods be charged:
 *
 *  1. IT NOW COVERS CROSS-SELL ITEMS. This logic used to be inlined in the final
 *     `else` of the per-item chain below, so it ran for regular items only.
 *     Cross-sell promo lines matched the earlier CROSSELL_PROMO branch, which
 *     checks price and quantity but never inventory — a sold-out cross-sell was
 *     discounted, accepted, and charged. Stock is stock regardless of the
 *     category an item was added under.
 *
 *  2. IT AGGREGATES PER CODE RATHER THAN PER LINE. The same product legitimately
 *     occupies more than one cart line: the cross-sell popup splits an over-limit
 *     add into a discounted CROSSELL_PROMO line PLUS a full-price DEFAULT line
 *     with the SAME code. Comparing each line against total inventory on its own
 *     let both pass while together overselling — with 3 in stock, a promo line of
 *     3 and an overflow line of 2 each looked fine and sold 5. Quantities are now
 *     summed per code and checked once.
 *
 * Summing is also why quantity is parsed here: Foxy reports it as a string often
 * enough that `a + b` would concatenate ("1" + "2" → "12") rather than add.
 */
const collectStockShortfalls = async (cartItems, shippingId) => {
  // Everything needs stock except memberships (not physical) and anything flagged
  // Delayed_shipping, which is knowingly fulfilled from a later restock.
  const required = new Map(); // code -> { qty, name }

  for (const cartItem of cartItems) {
    if (cartItem["_embedded"]["fx:item_category"].code === "memberships") continue;

    const isDelayedShipping = cartItem["_embedded"]["fx:item_options"]?.some(
      (option) => option.name === "Delayed_shipping"
    );
    if (isDelayedShipping) continue;

    const qty = parseInt(cartItem.quantity, 10) || 0;
    const prev = required.get(cartItem.code);
    if (prev) {
      prev.qty += qty;
    } else {
      required.set(cartItem.code, { qty, name: cartItem.name });
    }
  }

  const shortfalls = [];

  // One Airtable lookup per unique code — fewer than the old per-line version.
  await Promise.all(
    [...required.entries()].map(async ([code, need]) => {
      const tableRecords = await getProductInventory(code);

      if (tableRecords.length !== 1) {
        console.log(
          `No records found for WPC ${code} in Products or Product Variants table`
        );
        shortfalls.push({ type: "invalidCode", value: code });
        return;
      }

      const inventorySum = tableRecords[0].inventorySum;
      const inventoryChesterfield = tableRecords[0].inventoryChesterfield;
      const inventoryWarehouse = tableRecords[0].inventoryWarehouse;
      const inventoryStPeters = tableRecords[0].inventoryStPeters;

      const cartQuantity = need.qty;

      if (shippingId === "10011") {
        // pickup in Chesterfield
        if (inventoryChesterfield + inventoryWarehouse < cartQuantity) {
          console.log(
            `Inventory for ${need.name} (WPC: ${code}) is ${
              inventoryChesterfield + inventoryWarehouse
            }, but having ${cartQuantity} in cart`
          );
          shortfalls.push({ type: "chesterfield", value: need.name });
        }
      } else if (shippingId === "10012") {
        // pickup in St Peters
        if (inventoryStPeters + inventoryWarehouse < cartQuantity) {
          console.log(
            `Inventory for ${need.name} (WPC: ${code}) is ${inventoryStPeters} + ${inventoryWarehouse}, but having ${cartQuantity} in cart`
          );
          shortfalls.push({ type: "stPeters", value: need.name });
        }
      } else if (!inventorySum || cartQuantity > inventorySum) {
        console.log(
          `Inventory for ${need.name} (WPC: ${code}) is ${inventorySum}, but having ${cartQuantity} in cart`
        );
        shortfalls.push({ type: "stock", value: need.name });
      }
    })
  );

  return shortfalls;
};

exports.handler = async (event, context) => {
  const payload = JSON.parse(event.body);
  const cartItems = payload["_embedded"]["fx:items"];
  const shippingId = payload["_embedded"]["fx:shipment"]["shipping_service_id"];

  try {
    const invalidProductCode = [];
    const insufficientStock = [];
    const insufficientStockChesterfield = [];
    const insufficientStockStPeters = [];
    const mismatchMembershipPrice = [];
    let hasActiveMembership = false;
    const crossellPriceMismatch = [];

    /** File a collectStockShortfalls() result under the matching rejection list. */
    const recordShortfall = (shortfall) => {
      if (!shortfall) return;
      if (shortfall.type === "invalidCode") {
        invalidProductCode.push(shortfall.value);
      } else if (shortfall.type === "chesterfield") {
        insufficientStockChesterfield.push(shortfall.value);
      } else if (shortfall.type === "stPeters") {
        insufficientStockStPeters.push(shortfall.value);
      } else {
        insufficientStock.push(shortfall.value);
      }
    };

    // Pre-fetch the cross-sell price map once before processing items,
    // so we don't hit Airtable per-item inside the Promise.all loop.
    const hasCrossSellItems = cartItems.some(
      (item) => item["_embedded"]["fx:item_category"].code === CROSSELL_PROMO_CATEGORY
    );
    const crossellPriceMap = hasCrossSellItems
      ? await fetchCrossSellPriceMap(base)
      : {};

    await Promise.all(
      cartItems.map(async (cartItem) => {
        if (cartItem["_embedded"]["fx:item_category"].code === "memberships") {
          if (cartItem.name === "Past Due Amount") return;

          if (cartItem.subscription_end_date === null) {
            // check if customer already has an active subscription
            const customerId = payload["_embedded"]["fx:customer"].id;

            if (customerId !== "0") {
              const foxy = new FoxySDK.Backend.API({
                refreshToken: FOXY_REFRESH_TOKEN,
                clientSecret: FOXY_CLIENT_SECRET,
                clientId: FOXY_CLIENT_ID,
              });

              const customerNode = foxy
                .follow("fx:store")
                .follow("fx:customers");
              const customerResponse = await customerNode.get({
                filters: [`id=${customerId}`],
              });
              const customerData = await customerResponse.json();
              const subscriptionResponse = await customerData._embedded[
                "fx:customers"
              ][0]._links["fx:subscriptions"].get();
              const subscriptionData = await subscriptionResponse.json();

              hasActiveMembership = subscriptionData._embedded[
                "fx:subscriptions"
              ].some((subscription) => subscription.is_active === true);
            }
          }

          // validate price for membership product
          const tableRecords = await getMembershipPrice(
            cartItem.code,
            cartItem.subscription_frequency
          );

          if (tableRecords.length !== 1) {
            console.log(
              `No records found for SKU ${cartItem.code} in Memberships table`
            );
            invalidProductCode.push(cartItem.code);
          } else {
            const tablePrice = tableRecords[0].price;
            const cartPrice = cartItem.price;

            if (cartPrice !== tablePrice) {
              console.log(
                `Price for ${cartItem.name} should be ${tablePrice}, but showing ${cartPrice} in cart`
              );
              mismatchMembershipPrice.push(cartItem.name);
            }
          }
        } else if (
          cartItem["_embedded"]["fx:item_category"].code === CROSSELL_PROMO_CATEGORY
        ) {
          // Cross-sell promo item: validate price against Airtable's live data.
          // Quantity limit is checked after this loop where we can sum across all items.
          const offer = crossellPriceMap[cartItem.code];

          if (offer === undefined) {
            // Code not found in Airtable's cross-sell products — reject.
            // This catches items added with a fabricated CROSSELL_PROMO category.
            // We're already rejecting the order, so there's no point resolving
            // stock for a code we don't recognise.
            console.log(`Unknown cross-sell promo code: ${cartItem.code}`);
            invalidProductCode.push(cartItem.code);
            return;
          }

          // Expected price uses the discount % configured in Airtable for this
          // offer (e.g. 50% off → pay 50%), not a hardcoded 40%.
          const payPct        = 100 - offer.discountPct;
          const expectedPrice = Math.round(offer.price * payPct) / 100;
          if (cartItem.price < expectedPrice - CROSSELL_PRICE_TOLERANCE) {
            console.log(
              `Cross-sell price mismatch for ${cartItem.name}: ` +
              `expected >= ${expectedPrice.toFixed(2)} ` +
              `(${offer.discountPct}% off ${offer.price}), got ${cartItem.price}`
            );
            crossellPriceMismatch.push(cartItem.name);
          }
        }
        // NB: stock is NOT checked here. It's checked once per product code after
        // this loop — see collectStockShortfalls — because the same code can span
        // several lines and a per-line check oversells.
      })
    );

    // Stock — one check per product code, across every line that code appears on.
    // Covers cross-sell promo lines, which used to skip inventory entirely.
    (await collectStockShortfalls(cartItems, shippingId)).forEach(recordShortfall);

    // Cross-sell quantity limit — checked here so we can sum across all items.
    // The cap is per product code and comes from Airtable ("Max Qty" /
    // "Cross-sell Max Qty"), matching how the popup enforces it. A blank value
    // means no cap. Units beyond the cap are added by the popup at full price
    // under the DEFAULT category, so they aren't counted here.
    const crossellQtyByCode = {};
    cartItems
      .filter(
        (item) =>
          item["_embedded"]["fx:item_category"].code === CROSSELL_PROMO_CATEGORY
      )
      .forEach((item) => {
        // Foxy can report quantity as a string — coerce before adding.
        const qty = parseInt(item.quantity, 10) || 0;
        crossellQtyByCode[item.code] = (crossellQtyByCode[item.code] || 0) + qty;
      });

    const crossellQtyExceeded = [];   // [{ code, qty, maxQty }]
    Object.keys(crossellQtyByCode).forEach((code) => {
      const offer = crossellPriceMap[code];
      if (!offer) return;             // unknown code already rejected above
      const qty = crossellQtyByCode[code];
      if (qty > offer.maxQty) {
        console.log(
          `Cross-sell promo qty exceeded for ${code}: ${qty} > ${offer.maxQty}`
        );
        crossellQtyExceeded.push({ code, qty, maxQty: offer.maxQty });
      }
    });

    // An unrecognised cross-sell code is reported twice — once by the promo branch
    // and once by the stock pass, which also can't find it. Tell the customer once.
    const invalidCodes = [...new Set(invalidProductCode)];

    if (
      invalidCodes.length > 0 ||
      insufficientStockChesterfield.length > 0 ||
      insufficientStockStPeters.length > 0 ||
      insufficientStock.length > 0 ||
      mismatchMembershipPrice.length > 0 ||
      hasActiveMembership ||
      crossellPriceMismatch.length > 0 ||
      crossellQtyExceeded.length > 0
    ) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: false,
          details: `${
            invalidCodes.length > 0
              ? `Invalid product code: ${invalidCodes}. `
              : ""
          }${
            insufficientStockChesterfield.length > 0
              ? `Insufficient stock in Chesterfield store: ${insufficientStockChesterfield}. `
              : ""
          }${
            insufficientStockStPeters.length > 0
              ? `Insufficient stock in St. Peters store: ${insufficientStockStPeters}. `
              : ""
          }${
            insufficientStock.length > 0
              ? `Insufficient stock: ${insufficientStock}. `
              : ""
          }${
            mismatchMembershipPrice.length > 0
              ? `Mismatch membership price: ${mismatchMembershipPrice}.`
              : ""
          }${
            hasActiveMembership
              ? "Looks like you already have an active membership."
              : ""
          }${
            crossellPriceMismatch.length > 0
              ? `The promotional price for ${crossellPriceMismatch.join(", ")} could not be validated. Please remove the item and add it again from the offer.`
              : ""
          }${
            crossellQtyExceeded.length > 0
              ? `The promotional price is limited to ${crossellQtyExceeded
                  .map((c) => c.maxQty)
                  .join(", ")} units per order. Please reduce the quantity of the promotional item in your cart.`
              : ""
          }`,
        }),
      };
    } else {
      console.log("All checks have passed");

      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
        }),
      };
    }
  } catch (error) {
    console.error(error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        details: "Internal error",
      }),
    };
  }
};
