function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 2) return [];

    const headerLine = lines[0];
    let sep = ',';
    if (headerLine.includes('\t')) sep = '\t';

    const headers = headerLine.split(sep).map(h => h.trim());
    const result = [];

    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(sep).map(v => v.trim());
        const obj = {};
        headers.forEach((header, index) => {
            if (header) {
                obj[header] = values[index];
            } else {
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
    return new Date(parts[2], parts[1] - 1, parts[0]);
}

function calculateCGT(allTransactions) {
    const assets = {};
    allTransactions.forEach(t => {
        if (!assets[t.isin]) assets[t.isin] = [];
        assets[t.isin].push({ ...t, processedQty: 0 });
    });

    const disposals = [];
    const currentPortfolio = {};

    for (const isin in assets) {
        const txs = assets[isin];
        const buyPool = [];

        const dates = [...new Set(txs.map(t => t.date.getTime()))].sort();

        const allBuys = txs.filter(t => t.quantity > 0).map(b => ({
            ...b,
            remainingQty: b.quantity,
            costPerUnit: Math.abs(b.totalEur) / b.quantity
        }));
        const allSells = txs.filter(t => t.quantity < 0).map(s => ({
            ...s,
            remainingQty: Math.abs(s.quantity)
        }));

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

        disposals.filter(d => d.isin === isin && d.gain < 0).forEach(d => {
            const fourWeeksAfter = new Date(d.date);
            fourWeeksAfter.setDate(fourWeeksAfter.getDate() + 28);
            const reacquisition = txs.find(t => t.quantity > 0 && t.date > d.date && t.date <= fourWeeksAfter);
            if (reacquisition) {
                d.restricted = true;
                d.notes = "Loss restricted (re-acquisition within 4 weeks)";
            }
        });

        const remainingBuys = allBuys.filter(b => b.remainingQty > 0);
        if (remainingBuys.length > 0) {
            const totalRemainingQty = remainingBuys.reduce((sum, b) => sum + b.remainingQty, 0);
            const totalRemainingCost = remainingBuys.reduce((sum, b) => sum + (b.remainingQty * b.costPerUnit), 0);
            currentPortfolio[isin] = {
                product: txs[0].product,
                remainingQty: totalRemainingQty,
                averageCostBasis: totalRemainingCost / totalRemainingQty,
                lastKnownPrice: txs[txs.length - 1].price
            };
        }
    }

    const yearSummaries = {};
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

    return { yearSummaries, currentPortfolio };
}

function simulateSellAll(transactions, currentPrices) {
    const today = new Date();

    const { currentPortfolio } = calculateCGT(transactions);

    const hypotheticalSells = [];
    for (const isin in currentPortfolio) {
        const asset = currentPortfolio[isin];
        if (asset.remainingQty > 0) {
            const price = currentPrices[isin] !== undefined ? currentPrices[isin] : asset.lastKnownPrice;
            hypotheticalSells.push({
                date: today,
                isin: isin,
                product: asset.product,
                quantity: -asset.remainingQty,
                price: price,
                totalEur: asset.remainingQty * price,
                orderId: 'HYPOTHETICAL'
            });
        }
    }

    const simulatedTransactions = [...transactions, ...hypotheticalSells];
    simulatedTransactions.sort((a, b) => a.date - b.date);

    const { yearSummaries } = calculateCGT(simulatedTransactions);
    return yearSummaries[today.getFullYear()] || { grossGain: 0, allowableLoss: 0, disposals: [] };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseCSV, parseDate, calculateCGT, simulateSellAll };
} else {
    window.simulateSellAll = simulateSellAll;
    window.parseCSV = parseCSV;
    window.parseDate = parseDate;
    window.calculateCGT = calculateCGT;
}
