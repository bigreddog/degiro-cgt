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
        allTransactions.forEach(t => {
            if (!assets[t.isin]) assets[t.isin] = [];
            assets[t.isin].push({ ...t, processedQty: 0 });
        });

        const disposals = [];

        for (const isin in assets) {
            const txs = assets[isin];
            const buyPool = [];

            // Group by Date for Same Day rule
            const dates = [...new Set(txs.map(t => t.date.getTime()))].sort();

            // Prepare buyPool and sells with all relevant metadata
            const allBuys = txs.filter(t => t.quantity > 0).map(b => ({
                ...b,
                remainingQty: b.quantity,
                costPerUnit: Math.abs(b.totalEur) / b.quantity
            }));
            const allSells = txs.filter(t => t.quantity < 0).map(s => ({
                ...s,
                remainingQty: Math.abs(s.quantity)
            }));

            // Identification Rule 1: Same Day
            dates.forEach(time => {
                const dayBuys = allBuys.filter(b => b.date.getTime() === time);
                const daySells = allSells.filter(s => s.date.getTime() === time);
                if (dayBuys.length === 0 || daySells.length === 0) return;

                let dayTotalBuyQty = dayBuys.reduce((sum, b) => sum + b.remainingQty, 0);
                let dayTotalSellQty = daySells.reduce((sum, s) => sum + s.remainingQty, 0);
                let sameDayMatched = Math.min(dayTotalBuyQty, dayTotalSellQty);

                if (sameDayMatched > 0) {
                    const avgBuyCostPerUnit = dayBuys.reduce((sum, b) => sum + (b.remainingQty * b.costPerUnit), 0) / dayTotalBuyQty;

                    daySells.forEach(s => {
                        const matched = (s.remainingQty / dayTotalSellQty) * sameDayMatched;
                        if (matched > 0) {
                            const proceeds = (matched / Math.abs(s.quantity)) * s.totalEur;
                            const cost = matched * avgBuyCostPerUnit;
                            disposals.push({
                                ...s,
                                date: new Date(time),
                                quantity: -matched,
                                totalEur: proceeds,
                                totalCost: cost,
                                gain: proceeds - cost,
                                matches: [{ qty: matched, buyDate: new Date(time), rule: 'Same Day' }],
                                qtyMatched: matched
                            });
                            s.remainingQty -= matched;
                        }
                    });

                    let buyRem = sameDayMatched;
                    dayBuys.forEach(b => {
                        const matched = Math.min(buyRem, b.remainingQty);
                        b.remainingQty -= matched;
                        buyRem -= matched;
                    });
                }
            });

            // Identification Rule 2: 4 Weeks Preceding (FIFO among them)
            allSells.filter(s => s.remainingQty > 0).forEach(s => {
                const fourWeeksAgo = new Date(s.date);
                fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

                const precedingBuys = allBuys.filter(b => b.remainingQty > 0 && b.date >= fourWeeksAgo && b.date < s.date);
                if (precedingBuys.length === 0) return;

                let qtyToMatch = s.remainingQty;
                const matches = [];

                for (const buy of precedingBuys) {
                    if (qtyToMatch <= 0) break;
                    const matched = Math.min(qtyToMatch, buy.remainingQty);
                    matches.push({ qty: matched, buyDate: buy.date, rule: '4-Week Preceding', cost: matched * buy.costPerUnit });
                    buy.remainingQty -= matched;
                    qtyToMatch -= matched;
                }

                if (matches.length > 0) {
                    const totalCost = matches.reduce((sum, m) => sum + m.cost, 0);
                    const matchedQty = s.remainingQty - qtyToMatch;
                    const proceeds = (matchedQty / Math.abs(s.quantity)) * s.totalEur;
                    disposals.push({
                        ...s,
                        quantity: -matchedQty,
                        totalEur: proceeds,
                        totalCost,
                        gain: proceeds - totalCost,
                        matches,
                        qtyMatched: matchedQty
                    });
                    s.remainingQty = qtyToMatch;
                }
            });

            // Identification Rule 3: 4 Weeks Following (FIFO among them)
            allSells.filter(s => s.remainingQty > 0).forEach(s => {
                const fourWeeksAfter = new Date(s.date);
                fourWeeksAfter.setDate(fourWeeksAfter.getDate() + 28);

                const followingBuys = allBuys.filter(b => b.remainingQty > 0 && b.date > s.date && b.date <= fourWeeksAfter);
                if (followingBuys.length === 0) return;

                let qtyToMatch = s.remainingQty;
                const matches = [];

                for (const buy of followingBuys) {
                    if (qtyToMatch <= 0) break;
                    const matched = Math.min(qtyToMatch, buy.remainingQty);
                    matches.push({ qty: matched, buyDate: buy.date, rule: '4-Week Following', cost: matched * buy.costPerUnit });
                    buy.remainingQty -= matched;
                    qtyToMatch -= matched;
                }

                if (matches.length > 0) {
                    const totalCost = matches.reduce((sum, m) => sum + m.cost, 0);
                    const matchedQty = s.remainingQty - qtyToMatch;
                    const proceeds = (matchedQty / Math.abs(s.quantity)) * s.totalEur;
                    disposals.push({
                        ...s,
                        quantity: -matchedQty,
                        totalEur: proceeds,
                        totalCost,
                        gain: proceeds - totalCost,
                        matches,
                        qtyMatched: matchedQty
                    });
                    s.remainingQty = qtyToMatch;
                }
            });

            // Identification Rule 4: Normal FIFO (Oldest first)
            allSells.filter(s => s.remainingQty > 0).forEach(s => {
                let qtyToMatch = s.remainingQty;
                const matches = [];

                const availableBuys = allBuys.filter(b => b.remainingQty > 0 && b.date < s.date);
                for (const buy of availableBuys) {
                    if (qtyToMatch <= 0) break;
                    const matched = Math.min(qtyToMatch, buy.remainingQty);
                    matches.push({ qty: matched, buyDate: buy.date, rule: 'FIFO', cost: matched * buy.costPerUnit });
                    buy.remainingQty -= matched;
                    qtyToMatch -= matched;
                }

                const totalCost = matches.reduce((sum, m) => sum + m.cost, 0);
                const matchedQty = s.remainingQty - qtyToMatch;
                const proceeds = (matchedQty / Math.abs(s.quantity)) * s.totalEur;
                disposals.push({
                    ...s,
                    quantity: -matchedQty,
                    totalEur: proceeds,
                    totalCost,
                    gain: proceeds - totalCost,
                    matches,
                    qtyMatched: matchedQty
                });
                s.remainingQty = qtyToMatch;
            });

            // Rule 5: Loss Restriction (Section 581(3) TCA 1997)
            // If any disposal resulted in a loss, and same-class shares were re-acquired within 4 weeks AFTER.
            // Note: Section 581(3) says "loss arising on the disposal is only allowable against any gain that may accrue on the disposal of the shares reacquired".
            disposals.filter(d => d.isin === isin && d.gain < 0).forEach(d => {
                const fourWeeksAfter = new Date(d.date);
                fourWeeksAfter.setDate(fourWeeksAfter.getDate() + 28);
                // Check if any buy happened within 4 weeks after.
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

            const matchesHtml = d.matches.map(m =>
                `${escapeHtml(m.qty.toString())} @ ${escapeHtml(m.buyDate.toLocaleDateString())} (${escapeHtml(m.rule)})`
            ).join('<br>');

            row.innerHTML = `
                <td>${escapeHtml(d.date.toLocaleDateString())}</td>
                <td>${escapeHtml(d.product)}</td>
                <td>SELL</td>
                <td>${escapeHtml(Math.abs(d.quantity).toString())}</td>
                <td>${escapeHtml(d.price.toFixed(2))}</td>
                <td>${escapeHtml(d.totalCost.toFixed(2))}</td>
                <td class="${d.gain >= 0 ? 'gain' : 'loss'}">€${escapeHtml(d.gain.toFixed(2))}</td>
                <td>
                    ${escapeHtml(d.notes || '')}
                    ${d.qtyMatched < Math.abs(d.quantity) ? 'Partial match!' : ''}
                    <div style="font-size: 0.8em; color: #888;">
                        ${matchesHtml}
                    </div>
                </td>
            `;
            detailsTableBody.appendChild(row);
        });
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
});
