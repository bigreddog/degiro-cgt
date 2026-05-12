document.addEventListener('DOMContentLoaded', () => {
    const csvFileInput = document.getElementById('csvFile');
    const fileNameSpan = document.getElementById('fileName');
    const resultsDiv = document.getElementById('results');
    const yearSelect = document.getElementById('yearSelect');
    const detailsTableBody = document.querySelector('#detailsTable tbody');

    // Modal elements
    const viewPortfolioBtn = document.getElementById('viewPortfolioBtn');
    const portfolioModal = document.getElementById('portfolioModal');
    const closeModalBtn = document.querySelector('.close');
    const portfolioTableBody = document.querySelector('#portfolioTable tbody');

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
        const rows = window.parseCSV(csvText);
        if (rows.length === 0) {
            alert('No valid transactions found.');
            return;
        }

        allTransactions = rows.map(row => ({
            date: window.parseDate(row['Date']),
            product: row['Product'],
            isin: row['ISIN'],
            quantity: parseFloat(row['Quantity']),
            price: parseFloat(row['Price']),
            totalEur: parseFloat(row['Total EUR']),
            orderId: row['Order ID']
        })).filter(t => !isNaN(t.quantity) && t.isin);

        // Sort by date and time (if available, though date is primary)
        allTransactions.sort((a, b) => a.date - b.date);

        const result = window.calculateCGT(allTransactions);
        yearSummaries = result.yearSummaries;
        window.currentPortfolio = result.currentPortfolio;

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

    // Modal logic
    if (viewPortfolioBtn) {
        viewPortfolioBtn.addEventListener('click', () => {
            populatePortfolioModal();
            portfolioModal.classList.remove('hidden');
        });
    }

    if (closeModalBtn) {
        closeModalBtn.addEventListener('click', () => {
            portfolioModal.classList.add('hidden');
        });
    }

    if (portfolioModal) {
        window.addEventListener('click', (e) => {
            if (e.target === portfolioModal) {
                portfolioModal.classList.add('hidden');
            }
        });
    }

    async function fetchLivePrice(isin) {
        try {
            // A simple free proxy to Yahoo Finance, no auth required
            // Yahoo Finance symbol lookup can be tricky, this works decently for many ISINs.
            const searchUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${isin}&quotesCount=1`;
            const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(searchUrl)}`;

            const response = await fetch(proxyUrl);
            const data = await response.json();
            const result = JSON.parse(data.contents);

            if (result && result.quotes && result.quotes.length > 0) {
                const symbol = result.quotes[0].symbol;

                const quoteUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;
                const proxyQuoteUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(quoteUrl)}`;

                const quoteResponse = await fetch(proxyQuoteUrl);
                const quoteData = await quoteResponse.json();
                const quoteResult = JSON.parse(quoteData.contents);

                if (quoteResult && quoteResult.chart && quoteResult.chart.result && quoteResult.chart.result.length > 0) {
                    const price = quoteResult.chart.result[0].meta.regularMarketPrice;
                    return price;
                }
            }
            return null;
        } catch (err) {
            console.error(`Failed to fetch live price for ISIN: ${isin}`, err);
            return null;
        }
    }

    async function populatePortfolioModal() {
        if (!window.currentPortfolio) return;

        portfolioTableBody.innerHTML = '';
        const currentPrices = {};

        for (const isin in window.currentPortfolio) {
            const asset = window.currentPortfolio[isin];
            if (asset.remainingQty <= 0) continue;

            currentPrices[isin] = asset.lastKnownPrice;

            const row = document.createElement('tr');

            // Give inputs an ID so we can target them later
            const inputId = `price-input-${isin}`;

            row.innerHTML = `
                <td>${escapeHtml(asset.product)}</td>
                <td>${escapeHtml(asset.remainingQty.toString())}</td>
                <td>€${escapeHtml(asset.averageCostBasis.toFixed(2))}</td>
                <td><input type="number" step="0.01" class="price-input" id="${escapeHtml(inputId)}" data-isin="${escapeHtml(isin)}" value="${escapeHtml(asset.lastKnownPrice.toFixed(2))}"></td>
                <td class="est-gain">€0.00</td>
            `;
            portfolioTableBody.appendChild(row);
        }

        updateEstimates(currentPrices);

        // Add event listeners to inputs
        const inputs = portfolioTableBody.querySelectorAll('.price-input');
        inputs.forEach(input => {
            input.addEventListener('input', (e) => {
                const isin = e.target.getAttribute('data-isin');
                const val = parseFloat(e.target.value);
                if (!isNaN(val)) {
                    currentPrices[isin] = val;
                    updateEstimates(currentPrices);
                }
            });
        });

        // Asynchronously fetch live prices and update UI
        for (const isin in window.currentPortfolio) {
            const asset = window.currentPortfolio[isin];
            if (asset.remainingQty <= 0) continue;

            fetchLivePrice(isin).then(livePrice => {
                if (livePrice !== null && !isNaN(livePrice)) {
                    const inputElement = document.getElementById(`price-input-${isin}`);
                    if (inputElement) {
                        inputElement.value = livePrice.toFixed(2);

                        // Fire an artificial input event to trigger our estimation update
                        inputElement.dispatchEvent(new Event('input'));
                    }
                }
            });
        }
    }

    function updateEstimates(currentPrices) {
        // Update row-level gains
        const rows = portfolioTableBody.querySelectorAll('tr');
        rows.forEach(row => {
            const input = row.querySelector('.price-input');
            if (!input) return;
            const isin = input.getAttribute('data-isin');
            const asset = window.currentPortfolio[isin];
            const price = currentPrices[isin];

            const costBasis = asset.remainingQty * asset.averageCostBasis;
            const proceeds = asset.remainingQty * price;
            const gain = proceeds - costBasis;

            const estGainCell = row.querySelector('.est-gain');
            estGainCell.textContent = `€${gain.toFixed(2)}`;
            estGainCell.className = `est-gain ${gain >= 0 ? 'gain' : 'loss'}`;
        });

        // Update overall summary using the simulateSellAll function
        const summary = window.simulateSellAll(allTransactions, currentPrices);

        const netGainBeforeExemption = Math.max(0, summary.grossGain - summary.allowableLoss);
        const EXEMPTION = 1270;
        const taxableGain = Math.max(0, netGainBeforeExemption - EXEMPTION);
        const tax = taxableGain * 0.33;

        document.getElementById('estGrossGain').textContent = `€${summary.grossGain.toFixed(2)}`;
        document.getElementById('estAllowableLoss').textContent = `€${summary.allowableLoss.toFixed(2)}`;
        document.getElementById('estTaxPayable').textContent = `€${tax.toFixed(2)}`;
    }
});
