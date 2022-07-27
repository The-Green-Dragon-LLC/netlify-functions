import Airtable from "airtable";

const { AIRTABLE_API_KEY } = process.env;

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(
  "appWUsGD3byrYcN3l"
);

const productsTableId = "tblkLl9qqg654fWi7";
const variantsTableId = "tblEtb1aIH5Xk4Nh9";

const getTableRecords = async (productCode) => {
  const tableRecords = [];

  await base(productsTableId)
    .select({
      filterByFormula: `SKU = "${productCode}"`,
    })
    .eachPage(function page(records, fetchNextPage) {
      records.forEach((record) => {
        tableRecords.push({
          name: record.get("Name"),
          sku: record.get("SKU"),
          inventory: record.get("Inventory"),
        });
      });

      fetchNextPage();
    });

  if (tableRecords.length === 0) {
    await base(variantsTableId)
      .select({
        filterByFormula: `SKU = "${productCode}"`,
      })
      .eachPage(function page(records, fetchNextPage) {
        records.forEach((record) => {
          tableRecords.push({
            name: record.get("Name"),
            sku: record.get("SKU"),
            inventory: record.get("Inventory"),
          });
        });

        fetchNextPage();
      });
  }

  return tableRecords;
};

exports.handler = async (event, context) => {
  const payload = JSON.parse(event.body);
  const cartItems = payload["_embedded"]["fx:items"];

  try {
    const invalidProductCode = [];
    const insufficientStock = [];

    await Promise.all(
      cartItems.map(async (cartItem) => {
        const tableRecords = await getTableRecords(cartItem.code);

        if (tableRecords.length !== 1) {
          invalidProductCode.push(cartItem.code);
        } else {
          const inventory = tableRecords[0].inventory;
          const cartQuantity = cartItem.quantity;

          if (!inventory || cartQuantity > inventory) {
            insufficientStock.push(cartItem.name);
          }
        }
      })
    );

    if (invalidProductCode.length > 0 || insufficientStock.length > 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: false,
          details: `${
            invalidProductCode.length > 0
              ? `Invalid product code: ${invalidProductCode}. `
              : ""
          }${
            insufficientStock.length > 0
              ? `Insufficient stock: ${insufficientStock}`
              : ""
          }`,
        }),
      };
    } else {
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
