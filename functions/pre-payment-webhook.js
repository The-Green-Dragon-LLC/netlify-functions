const Airtable = require("airtable");
const FoxySDK = require("@foxy.io/sdk");
const {
  AIRTABLE_API_KEY,
  FOXY_REFRESH_TOKEN,
  FOXY_CLIENT_SECRET,
  FOXY_CLIENT_ID,
} = process.env;

// ─── Cross-sell promo validation ────────────────────────────────────────────
const CROSSELL_PROMO_CATEGORY  = "CROSSELL_PROMO";
const CROSSELL_PROMO_LIMIT     = 3;
const CROSSELL_PRICE_TOLERANCE = 0.01;
const CROSSELL_PRODUCTS_TABLE  = "tblkLl9qqg654fWi7";

/**
 * Fetches all products with "Cross-sell Promo" checked from Airtable and
 * returns a map of { [Website Product Code]: regularPrice }.
 * This is called at checkout time so no static price list needs to be
 * maintained — checking/unchecking the Airtable checkbox is enough.
 */
async function fetchCrossSellPriceMap(airtableBase) {
  const map = {};
  await airtableBase(CROSSELL_PRODUCTS_TABLE)
    .select({
      fields:          ["Website Product Code", "Price"],
      filterByFormula: `{Cross-sell Promo} = TRUE()`,
    })
    .eachPage((records, fetchNextPage) => {
      records.forEach((r) => {
        const code  = r.get("Website Product Code");
        const price = r.get("Price");
        if (code && price) map[code] = price;
      });
      fetchNextPage();
    });
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
          const regularPrice = crossellPriceMap[cartItem.code];

          if (regularPrice === undefined) {
            // Code not found in Airtable's cross-sell products — reject.
            // This catches items added with a fabricated CROSSELL_PROMO category.
            console.log(`Unknown cross-sell promo code: ${cartItem.code}`);
            invalidProductCode.push(cartItem.code);
          } else {
            // Expected price = 40% off the regular Airtable price
            const expectedPrice = Math.round(regularPrice * 60) / 100;
            if (cartItem.price < expectedPrice - CROSSELL_PRICE_TOLERANCE) {
              console.log(
                `Cross-sell price mismatch for ${cartItem.name}: ` +
                `expected >= ${expectedPrice.toFixed(2)}, got ${cartItem.price}`
              );
              crossellPriceMismatch.push(cartItem.name);
            }
          }
        } else {
          // ignore inventory validation if product has `Delayed shipping` option
          const isDelayedShipping = cartItem["_embedded"][
            "fx:item_options"
          ]?.some((option) => option.name === "Delayed_shipping");

          if (!isDelayedShipping) {
            const tableRecords = await getProductInventory(cartItem.code);

            if (tableRecords.length !== 1) { 
              console.log(
                `No records found for WPC ${cartItem.code} in Products or Product Variants table`
              );
              invalidProductCode.push(cartItem.code);
            } else {
              const inventorySum = tableRecords[0].inventorySum;
              const inventoryChesterfield =
                tableRecords[0].inventoryChesterfield;
              const inventoryWarehouse = tableRecords[0].inventoryWarehouse;
              const inventoryStPeters = tableRecords[0].inventoryStPeters;

              const cartQuantity = cartItem.quantity;

              if (shippingId === "10011") {
                // pickup in Chesterfield
                if (
                  inventoryChesterfield + inventoryWarehouse <
                  cartItem.quantity
                ) {
                  console.log(
                    `Inventory for ${cartItem.name} (WPC: ${
                      cartItem.code
                    }) is ${
                      inventoryChesterfield + inventoryWarehouse
                    }, but having ${cartQuantity} in cart`
                  );
                  insufficientStockChesterfield.push(cartItem.name);
                }
              } else if (shippingId === "10012") {
                // pickup in St Peters
                if (inventoryStPeters + inventoryWarehouse < cartItem.quantity) {
                  console.log(
                    `Inventory for ${cartItem.name} (WPC: ${cartItem.code}) is ${inventoryStPeters} + ${inventoryWarehouse}, but having ${cartQuantity} in cart`
                  );
                  insufficientStockStPeters.push(cartItem.name);
                }
              } else {
                if (!inventorySum || cartQuantity > inventorySum) {
                  console.log(
                    `Inventory for ${cartItem.name} (WPC: ${cartItem.code}) is ${inventorySum}, but having ${cartQuantity} in cart`
                  );
                  insufficientStock.push(cartItem.name);
                }
              }
            }
          }
        }
      })
    );

    // Cross-sell quantity limit — checked here so we can sum across all items
    const crossellPromoQty = cartItems
      .filter(
        (item) =>
          item["_embedded"]["fx:item_category"].code === CROSSELL_PROMO_CATEGORY
      )
      .reduce((sum, item) => sum + item.quantity, 0);

    const crossellQtyExceeded = crossellPromoQty > CROSSELL_PROMO_LIMIT;

    if (crossellQtyExceeded) {
      console.log(
        `Cross-sell promo qty exceeded: ${crossellPromoQty} > ${CROSSELL_PROMO_LIMIT}`
      );
    }

    if (
      invalidProductCode.length > 0 ||
      insufficientStockChesterfield.length > 0 ||
      insufficientStockStPeters.length > 0 ||
      insufficientStock.length > 0 ||
      mismatchMembershipPrice.length > 0 ||
      hasActiveMembership ||
      crossellPriceMismatch.length > 0 ||
      crossellQtyExceeded
    ) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: false,
          details: `${
            invalidProductCode.length > 0
              ? `Invalid product code: ${invalidProductCode}. `
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
            crossellQtyExceeded
              ? `The promotional price is limited to ${CROSSELL_PROMO_LIMIT} units per order. Please reduce the quantity of the promotional item in your cart.`
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
