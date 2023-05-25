const FoxySDK = require("@foxy.io/sdk");
const { FOXY_REFRESH_TOKEN, FOXY_CLIENT_SECRET, FOXY_CLIENT_ID } = process.env;
const customerByEmail = customerEmail =>
  `https://api.foxycart.com/stores/101277/customers?email=${customerEmail}`;
const createCustomer = "https://api.foxycart.com/stores/101277/customers";
const foxy = new FoxySDK.Backend.API({
  refreshToken: FOXY_REFRESH_TOKEN,
  clientSecret: FOXY_CLIENT_SECRET,
  clientId: FOXY_CLIENT_ID,
});

exports.handler = async (event, context) => {
  try {
    const { customer, customer_tier, is_update } = JSON.parse(event.body);
    const customerExists = await (await foxy.fetch(customerByEmail(customer.email))).json();

    // All together and lower case.
    const customerTier = customer_tier.split(" ").join("").toLowerCase();
    // Update Tier Flow
    if (is_update && customerExists.returned_items) {
      const customerAttributes =
        customerExists._embedded["fx:customers"][0]._links["fx:attributes"].href;
      console.log("Update Flow. customerAttributes", JSON.stringify(customerAttributes));
      const attributes = await (
        await foxy.fetch(customerAttributes, {
          method: "PATCH",
          // Needs to be an array because issue with API.
          body: JSON.stringify([{ name: "wholesale_tier", value: customerTier }]),
        })
      ).json();
      return {
        body: JSON.stringify({
          ok: true,
          data: {
            attributes,
          },
        }),
        statusCode: 200,
      };
    }

    //Create Customer and Add Tier Flow
    if (!customerExists.returned_items) {
      const res = await foxy.fetch(createCustomer, {
        method: "POST",
        body: JSON.stringify(customer),
      });
      const newCustomer = await res.json();
      console.log("newCustomer", JSON.stringify(newCustomer));

      const customerAttributes = newCustomer._links["fx:attributes"].href;

      const attributes = await (
        await foxy.fetch(customerAttributes, {
          method: "PATCH",
          body: JSON.stringify([{ name: "wholesale_tier", value: customerTier }]),
        })
      ).json();

      console.log("newCustomer attributes", attributes);
      return {
        body: JSON.stringify({
          ok: true,
          data: {
            customer: newCustomer,
            attributes,
          },
        }),
        statusCode: 200,
      };
    } else {
      return {
        body: JSON.stringify({
          ok: true,
          details: "Customer already exists",
        }),
        statusCode: 409,
      };
    }
  } catch (error) {
    console.log("ERROR: ", error);
    return {
      body: JSON.stringify({
        ok: false,
        details: "An error has occurred when creating the foxy customer",
      }),
      statusCode: 500,
    };
  }
};
