import Airtable from "airtable";

const { AIRTABLE_API_KEY } = process.env;

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(
  "appWUsGD3byrYcN3l"
);

const productsTableId = "tblkLl9qqg654fWi7";
const variantsTableId = "tblEtb1aIH5Xk4Nh9";

const getProductInventory = async (productCode) => {
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
          inventoryChesterfield: record.get("Inventory (Chesterfield)"),
          inventoryStPeters: record.get("Inventory (St Peters)"),
          inventoryWarehouse: record.get("Inventory (Warehouse)"),
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

exports.handler = async (event, context) => {
  const rates = [];
  const local_pickup = [
    63146, 63103, 63104, 63128, 63125, 63118, 63051, 63129, 63110, 63123, 63109,
    63073, 63032, 63139, 63049, 63112, 63025, 63135, 63301, 63341, 63031, 63121,
    63026, 63368, 63133, 63143, 63099, 63140, 63126, 63119, 63127, 63134, 63042,
    63130, 63105, 63117, 63144, 63145, 63376, 63114, 63038, 63044, 63122, 63124,
    63040, 63045, 63074, 63051, 63088, 63132, 63338, 63302, 63005, 63304, 63021,
    63131, 63043, 63022, 63011, 63024, 63146, 63141, 63303, 63006, 63088, 63017,
    63138, 63120, 63366, 63118, 63136, 63128, 63049, 63026, 63033, 63376, 63368,
    63367, 63043, 63348, 63385,
  ];
  const cart = JSON.parse(event.body);
  const postal_code = Number(cart["_embedded"]["fx:shipment"]["postal_code"]);
  const items = cart["_embedded"]["fx:items"];

  try {
    if (local_pickup.includes(postal_code)) {
      let pickup_chesterfield = true,
        pickup_st_peters = true;

      await Promise.all(
        items.map(async (item) => {
          const tableRecords = await getProductInventory(item.code);

          if (tableRecords.length > 0) {
            const inventoryChesterfield = tableRecords[0].inventoryChesterfield;
            const inventoryWarehouse = tableRecords[0].inventoryWarehouse;
            const inventoryStPeters = tableRecords[0].inventoryStPeters;

            if (inventoryChesterfield + inventoryWarehouse < item.quantity) {
              pickup_chesterfield = false;
            }

            if (inventoryStPeters < item.quantity) {
              pickup_st_peters = false;
            }
          }
        })
      ).then(() => {
        if (pickup_chesterfield) {
          rates.push({
            service_id: 10011,
            price: 0,
            method: "",
            service_name:
              "Local Pickup: Chesterfield Store (Allow 2 hours - same day if ordered before 3PM)",
          });
        }

        if (pickup_st_peters) {
          rates.push({
            service_id: 10012,
            price: 0,
            method: "",
            service_name: "Local Pickup: St. Peters Store",
          });
        }
      });
    }

    return {
      body: JSON.stringify({
        ok: true,
        data: {
          shipping_results: rates,
        },
      }),
      statusCode: 200,
    };
  } catch (error) {
    console.error(error);
    return {
      body: JSON.stringify({
        ok: false,
        details: "An error has occurred when fetching shipping rates",
      }),
      statusCode: 500,
    };
  }
};
