const { parseCSV, parseDate, calculateCGT, simulateSellAll } = require('./cgt.js');

describe('parseDate', () => {
    it('parses DD-MM-YYYY correctly', () => {
        const date = parseDate('15-05-2023');
        expect(date.getFullYear()).toBe(2023);
        expect(date.getMonth()).toBe(4); // May is month 4
        expect(date.getDate()).toBe(15);
    });

    it('returns null for invalid strings', () => {
        expect(parseDate('')).toBeNull();
        expect(parseDate('12/12/2023')).toBeNull();
    });
});

describe('calculateCGT', () => {
    it('handles simple FIFO properly', () => {
        const transactions = [
            { date: new Date(2021, 0, 10), isin: 'IE001', quantity: 100, price: 10, totalEur: -1000, product: 'Stock A' },
            { date: new Date(2021, 1, 10), isin: 'IE001', quantity: 100, price: 15, totalEur: -1500, product: 'Stock A' },
            { date: new Date(2021, 2, 10), isin: 'IE001', quantity: -150, price: 20, totalEur: 3000, product: 'Stock A' }
        ];

        const { yearSummaries, currentPortfolio } = calculateCGT(transactions);
        const summary = yearSummaries[2021];

        expect(summary).toBeDefined();
        // Sells 150 on March 10.
        // 4-week preceding rule matches 100 from Feb 10 (cost = 1500). Proceeds = 2000. Gain = 500.
        // FIFO matches remaining 50 from Jan 10 (cost = 500). Proceeds = 1000. Gain = 500.
        // Total gain = 1000.
        expect(summary.grossGain).toBeCloseTo(1000);
        expect(summary.allowableLoss).toBe(0);
        expect(summary.disposals[0].totalCost).toBe(1500); // 4-week match
        expect(summary.disposals[1].totalCost).toBe(500); // FIFO match

        expect(currentPortfolio['IE001'].remainingQty).toBe(50);
    });

    it('handles the Same Day rule', () => {
        const transactions = [
            { date: new Date(2021, 0, 10), isin: 'IE001', quantity: 100, price: 10, totalEur: -1000, product: 'Stock A' }, // Buy earlier
            { date: new Date(2021, 5, 10), isin: 'IE001', quantity: 50, price: 15, totalEur: -750, product: 'Stock A' }, // Buy on same day
            { date: new Date(2021, 5, 10), isin: 'IE001', quantity: -50, price: 20, totalEur: 1000, product: 'Stock A' } // Sell on same day
        ];

        const { yearSummaries, currentPortfolio } = calculateCGT(transactions);
        const summary = yearSummaries[2021];

        // Sell 50 should match Same Day buy of 50. Cost = 750. Proceeds = 1000. Gain = 250.
        expect(summary.grossGain).toBeCloseTo(250);
        expect(summary.disposals[0].matches[0].rule).toBe('Same Day');

        // The earlier buy of 100 should be untouched.
        expect(currentPortfolio['IE001'].remainingQty).toBe(100);
    });

    it('handles the 4-week preceding rule', () => {
        const transactions = [
            { date: new Date(2021, 0, 10), isin: 'IE001', quantity: 100, price: 10, totalEur: -1000, product: 'Stock A' }, // Earlier
            { date: new Date(2021, 5, 1), isin: 'IE001', quantity: 50, price: 15, totalEur: -750, product: 'Stock A' },  // Within 4 weeks
            { date: new Date(2021, 5, 15), isin: 'IE001', quantity: -50, price: 20, totalEur: 1000, product: 'Stock A' } // Sell
        ];

        const { yearSummaries } = calculateCGT(transactions);
        const summary = yearSummaries[2021];

        // Should match the buy on 5/1. Cost = 750. Gain = 250.
        expect(summary.disposals[0].matches[0].rule).toBe('4-Week Preceding');
        expect(summary.grossGain).toBe(250);
    });

    it('handles the 4-week following rule (anti-bed-and-breakfasting)', () => {
        const transactions = [
            { date: new Date(2021, 0, 10), isin: 'IE001', quantity: 100, price: 20, totalEur: -2000, product: 'Stock A' }, // Buy original
            { date: new Date(2021, 5, 10), isin: 'IE001', quantity: -100, price: 10, totalEur: 1000, product: 'Stock A' }, // Sell for a loss
            { date: new Date(2021, 5, 15), isin: 'IE001', quantity: 100, price: 12, totalEur: -1200, product: 'Stock A' }  // Buy back within 4 weeks
        ];

        const { yearSummaries } = calculateCGT(transactions);
        const summary = yearSummaries[2021];

        // The sell should match the 4-week following buy. Cost = 1200. Proceeds = 1000. Gain = -200.
        expect(summary.disposals[0].matches[0].rule).toBe('4-Week Following');
        expect(summary.disposals[0].totalCost).toBe(1200);
        expect(summary.disposals[0].gain).toBe(-200);
    });

    it('restricts losses correctly (Section 581(3))', () => {
        const transactions = [
            { date: new Date(2021, 0, 10), isin: 'IE001', quantity: 100, price: 20, totalEur: -2000, product: 'Stock A' }, // Buy original
            { date: new Date(2021, 5, 10), isin: 'IE001', quantity: -100, price: 10, totalEur: 1000, product: 'Stock A' }, // Sell for a loss (Cost=2000)
            { date: new Date(2021, 5, 15), isin: 'IE001', quantity: 100, price: 12, totalEur: -1200, product: 'Stock A' }  // Re-acquire
        ];

        const { yearSummaries } = calculateCGT(transactions);
        const summary = yearSummaries[2021];

        expect(summary.disposals[0].gain).toBe(-200); // Because it matched the following buy!
        expect(summary.disposals[0].restricted).toBe(true);
        expect(summary.allowableLoss).toBe(0); // Loss is not generally allowable
    });
});

describe('simulateSellAll', () => {
    it('simulates selling all remaining positions at current prices', () => {
        const transactions = [
            { date: new Date(2021, 0, 10), isin: 'IE001', quantity: 100, price: 10, totalEur: -1000, product: 'Stock A' },
            { date: new Date(2021, 1, 10), isin: 'IE002', quantity: 50, price: 20, totalEur: -1000, product: 'Stock B' }
        ];

        const prices = {
            'IE001': 15, // Gain of 5 per share = 500
            'IE002': 10  // Loss of 10 per share = -500
        };

        const currentYearSummary = simulateSellAll(transactions, prices);

        expect(currentYearSummary.grossGain).toBeCloseTo(500);
        expect(currentYearSummary.allowableLoss).toBeCloseTo(500);
    });
});
