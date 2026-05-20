/**
 * PestPac /Invoices?orderId=… Probe — proves per-order access pattern
 *
 * Confirmed via InvoicesProbe.gs: PestPac's /Invoices endpoint requires
 * a specific identifier — orderId, orderNumber, invoiceNumber, or externalIdentifier.
 * It is NOT a list-by-date endpoint.
 *
 * This script confirms the per-order invoice access pattern works against
 * real OrderIDs and OrderNumbers from your data, and shows the full response
 * shape so we can plan the eventual billing-detail drill-down view.
 *
 * USAGE
 *   Same PestPac Discovery Apps Script project.
 *   File → + → Script → name "OrderInvoicesProbe" → paste this → save.
 *   Pick probeOrderInvoices from the function dropdown → Run.
 *   Paste the log back.
 *
 *   (No need to run this immediately — Phase 1 dashboard doesn't depend on it.
 *    Run it when we're ready to build the per-order billing drill-down.)
 */

function probeOrderInvoices() {
  Logger.log('🔍 Per-order invoice probe — ' + new Date().toISOString());

  const token = ppToken_();

  // Step 1: pick a few recent ServiceOrders. We need real OrderIDs and OrderNumbers to probe with.
  var end = new Date();
  var start = new Date(); start.setDate(start.getDate() - 14);
  var fmt = function(d) {
    return d.getFullYear() + '-' +
           String(d.getMonth()+1).padStart(2,'0') + '-' +
           String(d.getDate()).padStart(2,'0');
  };
  var ords = ppGet_(token, '/ServiceOrders?startWorkDate=' + fmt(start) + '&endWorkDate=' + fmt(end));
  if (ords.code !== 200) {
    Logger.log('  Could not pull ServiceOrders: HTTP ' + ords.code);
    return;
  }
  var orders = JSON.parse(ords.text)
    .filter(function(o) { return o.OrderType !== 'Estimate' && o.Posted === true; })
    .slice(0, 5);
  Logger.log('  Probing ' + orders.length + ' Posted orders');

  // Step 2: for each, try both orderId and orderNumber lookups
  orders.forEach(function(o, idx) {
    Logger.log('\n═══ Order ' + (idx+1) + ' — OrderID=' + o.OrderID + ', OrderNumber=' + o.OrderNumber + ', Branch=' + o.Branch + ' ═══');

    var tries = [
      '/Invoices?orderId=' + o.OrderID,
      '/Invoices?orderNumber=' + o.OrderNumber
    ];
    tries.forEach(function(path) {
      var r = ppGet_(token, path);
      Logger.log('  ' + path + ' → HTTP ' + r.code + '  (' + (r.text ? r.text.length : 0) + ' bytes)');
      if (r.code === 200) {
        try {
          var data = JSON.parse(r.text);
          var arr = Array.isArray(data) ? data : [data];
          Logger.log('    returned ' + arr.length + ' invoice(s)');
          if (arr.length > 0) {
            var fields = Object.keys(arr[0]).sort();
            Logger.log('    fields (' + fields.length + '): ' + fields.join(', '));
            Logger.log('    sample: ' + JSON.stringify(arr[0]).substring(0, 600));
          }
        } catch (e) {
          Logger.log('    parse error: ' + e.message);
        }
      } else if (r.text) {
        Logger.log('    body: ' + r.text.substring(0, 300));
      }
    });
    Utilities.sleep(300);
  });

  Logger.log('\n✅ Per-order probe complete');
}
