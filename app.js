document.addEventListener('DOMContentLoaded', () => {
    const csvFileInput = document.getElementById('csvFile');
    const fileNameSpan = document.getElementById('fileName');
    const resultsDiv = document.getElementById('results');
    const yearSelect = document.getElementById('yearSelect');
    const detailsTableBody = document.querySelector('#detailsTable tbody');

    let allTransactions = [];
    let yearSummaries = {};

    csvFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        fileNameSpan.textContent = file.name;
        const reader = new FileReader();
        reader.onload = (event) => {
            const text = event.target.result;
            processData(text);
        };
        reader.readAsText(file);
    });

    yearSelect.addEventListener('change', () => {
        displayYear(yearSelect.value);
    });

    function processData(csvText) {
        const rows = parseCSV(csvText);
        if (rows.length === 0) {
            alert('No valid transactions found.');
            return;
        }

        allTransactions = rows.map(row => ({
            date: parseDate(row['Date']),
            product: row['Product'],
            isin: row['ISIN'],
            quantity: parseFloat(row['Quantity']),
            price: parseFloat(row['Price']),
            totalEur: parseFloat(row['Total EUR']),
            orderId: row['Order ID']
        })).filter(t => !isNaN(t.quantity) && t.isin);

        // Sort by date and time (if available, though date is primary)
        allTransactions.sort((a, b) => a.date - b.date);

        calculateCGT();
    }

    function parseCSV(text) {
        const lines = text.split(/\r?\n/).filter(line => line.trim());
        if (lines.length < 2) return [];

        // Detect separator (DeGiro often uses tab or comma)
        const headerLine = lines[0];
        let sep = ',';
        if (headerLine.includes('\t')) sep = '\t';

        const headers = headerLine.split(sep).map(h => h.trim());
        const result = [];

        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(sep).map(v => v.trim());
            const obj = {};
            // DeGiro CSV sometimes has more values than headers or vice versa
            headers.forEach((header, index) => {
                if (header) {
                    obj[header] = values[index];
                } else {
                    // Handle unnamed columns (like currency columns in the example)
                    obj[`_col${index}`] = values[index];
                }
            });
            result.push(obj);
        }
        return result;
    }

    function parseDate(dateStr) {
        if (!dateStr) return null;
        const parts = dateStr.split('-');
        if (parts.length !== 3) return null;
        // DD-MM-YYYY
        return new Date(parts[2], parts[1] - 1, parts[0]);
    }

    function calculateCGT() {
        const assets = {};
        // Group by ISIN
        allTransactions.forEach(t => {
            if (!assets[t.isin]) assets[t.isin] = [];
            assets[t.isin].push({...t});
        });

        const disposals = [];

        for (const isin in assets) {
            const txs = assets[isin];
            const buys = [];

            txs.forEach(tx => {
                if (tx.quantity > 0) {
                    buys.push({
                        ...tx,
                        remainingQty: tx.quantity,
                        costPerUnit: Math.abs(tx.totalEur) / tx.quantity
                    });
                } else {
                    let qtyToMatch = Math.abs(tx.quantity);
                    const proceedsPerUnit = tx.totalEur / qtyToMatch;
                    const matches = [];

                    // Priority 1: Same day rule
                    const sameDayBuys = buys.filter(b => b.remainingQty > 0 && b.date.getTime() === tx.date.getTime());
                    for (const buy of sameDayBuys) {
                        if (qtyToMatch <= 0) break;
                        const matchedQty = Math.min(qtyToMatch, buy.remainingQty);
                        matches.push({
                            buyDate: buy.date,
                            qty: matchedQty,
                            cost: matchedQty * buy.costPerUnit,
                            rule: 'Same Day'
                        });
                        buy.remainingQty -= matchedQty;
                        qtyToMatch -= matchedQty;
                    }

                    // Priority 2: 4-week rule (acquisitions in 4 weeks preceding)
                    const fourWeeksAgo = new Date(tx.date);
                    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

                    const recentBuys = buys.filter(b => b.remainingQty > 0 && b.date >= fourWeeksAgo && b.date < tx.date);
                    // Revenue specifies FIFO for these too
                    recentBuys.sort((a,b) => a.date - b.date);

                    for (const buy of recentBuys) {
                        if (qtyToMatch <= 0) break;
                        const matchedQty = Math.min(qtyToMatch, buy.remainingQty);
                        matches.push({
                            buyDate: buy.date,
                            qty: matchedQty,
                            cost: matchedQty * buy.costPerUnit,
                            rule: '4-Week Rule'
                        });
                        buy.remainingQty -= matchedQty;
                        qtyToMatch -= matchedQty;
                    }

                    // Priority 3: Normal FIFO (acquisitions before the 4-week window)
                    const olderBuys = buys.filter(b => b.remainingQty > 0 && b.date < fourWeeksAgo);
                    olderBuys.sort((a,b) => a.date - b.date);

                    for (const buy of olderBuys) {
                        if (qtyToMatch <= 0) break;
                        const matchedQty = Math.min(qtyToMatch, buy.remainingQty);
                        matches.push({
                            buyDate: buy.date,
                            qty: matchedQty,
                            cost: matchedQty * buy.costPerUnit,
                            rule: 'FIFO'
                        });
                        buy.remainingQty -= matchedQty;
                        qtyToMatch -= matchedQty;
                    }

                    const totalCost = matches.reduce((sum, m) => sum + m.cost, 0);
                    const gain = tx.totalEur - totalCost;

                    disposals.push({
                        ...tx,
                        matches,
                        totalCost,
                        gain,
                        qtyMatched: Math.abs(tx.quantity) - qtyToMatch
                    });
                }
            });

            // Rule 3: Loss Restriction (Re-acquisition within 4 weeks AFTER)
            // If a disposal resulted in a loss, and there's a buy within 4 weeks after.
            // This is complex as it might affect multiple disposals.
            // Simplified: Mark losses as restricted if a re-acquisition exists within 4 weeks after.
            disposals.filter(d => d.isin === isin && d.gain < 0).forEach(d => {
                const fourWeeksAfter = new Date(d.date);
                fourWeeksAfter.setDate(fourWeeksAfter.getDate() + 28);
                const reacquisition = txs.find(t => t.quantity > 0 && t.date > d.date && t.date <= fourWeeksAfter);
                if (reacquisition) {
                    d.restricted = true;
                    d.notes = "Loss restricted (re-acquisition within 4 weeks)";
                }
            });
        }

        // Aggregate by year
        yearSummaries = {};
        disposals.forEach(d => {
            const year = d.date.getFullYear();
            if (!yearSummaries[year]) {
                yearSummaries[year] = {
                    grossGain: 0,
                    allowableLoss: 0,
                    disposals: []
                };
            }
            yearSummaries[year].disposals.push(d);
            if (d.gain > 0) {
                yearSummaries[year].grossGain += d.gain;
            } else if (!d.restricted) {
                yearSummaries[year].allowableLoss += Math.abs(d.gain);
            }
        });

        populateYearSelect();
        resultsDiv.classList.remove('hidden');
        displayYear(Object.keys(yearSummaries).sort((a,b) => b-a)[0]);
    }

    function populateYearSelect() {
        const years = Object.keys(yearSummaries).sort((a, b) => b - a);
        yearSelect.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
    }

    function displayYear(year) {
        const summary = yearSummaries[year];
        if (!summary) return;

        const netGainBeforeExemption = Math.max(0, summary.grossGain - summary.allowableLoss);
        const EXEMPTION = 1270;
        const taxableGain = Math.max(0, netGainBeforeExemption - EXEMPTION);
        const tax = taxableGain * 0.33;

        document.getElementById('grossGain').textContent = `€${summary.grossGain.toFixed(2)}`;
        document.getElementById('allowableLoss').textContent = `€${summary.allowableLoss.toFixed(2)}`;
        document.getElementById('netGain').textContent = `€${netGainBeforeExemption.toFixed(2)}`;
        document.getElementById('taxPayable').textContent = `€${tax.toFixed(2)}`;

        detailsTableBody.innerHTML = '';
        summary.disposals.forEach(d => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${d.date.toLocaleDateString()}</td>
                <td>${d.product}</td>
                <td>SELL</td>
                <td>${Math.abs(d.quantity)}</td>
                <td>${d.price.toFixed(2)}</td>
                <td>${d.totalCost.toFixed(2)}</td>
                <td class="${d.gain >= 0 ? 'gain' : 'loss'}">€${d.gain.toFixed(2)}</td>
                <td>
                    ${d.notes || ''}
                    ${d.qtyMatched < Math.abs(d.quantity) ? 'Partial match!' : ''}
                    <div style="font-size: 0.8em; color: #888;">
                        ${d.matches.map(m => `${m.qty} @ ${m.buyDate.toLocaleDateString()} (${m.rule})`).join('<br>')}
                    </div>
                </td>
            `;
            detailsTableBody.appendChild(row);
        });
    }
});
