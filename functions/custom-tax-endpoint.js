exports.handler = async (event, context) => {
  try {
    const payload = JSON.parse(event.body);
    const totalShipping = payload.total_shipping;
    const totalItemPrice = payload.total_item_price;
    const totalDiscount = payload.total_discount;
    const region = payload.shipping_state;

    const taxRate =
      region === "MO" ? (totalShipping === 0 ? 0.08738 : 0.08238) : 0;
    const taxAmount =
      Math.round(
        taxRate * (totalItemPrice + totalDiscount + totalShipping) * 100
      ) / 100;

    const taxConfiguration = {
      ok: true,
      details: "",
      name: "Tax",
      expand_taxes: [
        {
          name: "Tax",
          rate: taxRate,
          amount: taxAmount,
        },
      ],
      total_amount: taxAmount,
      total_rate: taxRate,
    };

    return {
      body: JSON.stringify(taxConfiguration),
      statusCode: 200,
    };
  } catch (error) {
    console.error(error);
    return {
      body: JSON.stringify({
        ok: false,
        details: "An error has occurred when fetching tax rates",
      }),
      statusCode: 500,
    };
  }
};
