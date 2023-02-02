import Airtable from "airtable";

const { AIRTABLE_API_KEY } = process.env;

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

    await Promise.all(
      cartItems.map(async (cartItem) => {
        if (cartItem["_embedded"]["fx:item_category"].code === "memberships") {
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
                if (inventoryStPeters < cartItem.quantity) {
                  console.log(
                    `Inventory for ${cartItem.name} (WPC: ${cartItem.code}) is ${inventoryStPeters}, but having ${cartQuantity} in cart`
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

    if (
      invalidProductCode.length > 0 ||
      insufficientStockChesterfield.length > 0 ||
      insufficientStockStPeters.length > 0 ||
      insufficientStock.length > 0 ||
      mismatchMembershipPrice.length > 0
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
