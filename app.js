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
        const currentYear = new Date().getFullYear().toString();
        if (!years.includes(currentYear)) {
            years.unshift(currentYear);
        }
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

    async function fetchLivePrice(isin, productName) {
        try {
            // Yahoo Finance symbol lookup can be tricky, this works decently for many ISINs.
            // Fetch multiple quotes in case the primary is a US ADR or non-equity listing.
            const searchUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${isin}&quotesCount=10`;
            const proxySearchUrl = `https://corsproxy.io/?url=${encodeURIComponent(searchUrl)}`;

            let response = await fetch(proxySearchUrl);
            let result = await response.json();

            if (!result || !result.quotes || result.quotes.length === 0) {
                // Fallback to searching by sanitized product name if ISIN fails
                const sanitizedName = productName.replace(/\b(CLASS \w*|INC|PLC|LTD|CORP)\b/gi, '').trim();
                const fallbackUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sanitizedName)}&quotesCount=10`;
                const proxyFallbackUrl = `https://corsproxy.io/?url=${encodeURIComponent(fallbackUrl)}`;
                const fallbackResponse = await fetch(proxyFallbackUrl);
                result = await fallbackResponse.json();
            }

            if (result && result.quotes && result.quotes.length > 0) {
                // Find the best equity listing. For major US tech stocks traded in Europe, the ISIN is the US ISIN.
                // If we don't prioritize US exchanges (NMS, NYQ) for those US ISINs/companies, Yahoo will return
                // low-volume, illiquid secondary cross-listings in Germany or similar, with wildly stale prices.
                let bestQuote = result.quotes.find(q => (q.quoteType === 'EQUITY' || q.quoteType === 'ETF') && (q.exchange === 'NMS' || q.exchange === 'NYQ'));

                if (!bestQuote) {
                    bestQuote = result.quotes.find(q => q.quoteType === 'EQUITY' || q.quoteType === 'ETF');
                }
                if (!bestQuote) bestQuote = result.quotes[0];

                const symbol = bestQuote.symbol;

                const quoteUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;
                const proxyQuoteUrl = `https://corsproxy.io/?url=${encodeURIComponent(quoteUrl)}`;
                const quoteResponse = await fetch(proxyQuoteUrl);
                const quoteResult = await quoteResponse.json();

                if (quoteResult && quoteResult.chart && quoteResult.chart.result && quoteResult.chart.result.length > 0) {
                    const meta = quoteResult.chart.result[0].meta;
                    let localPrice = meta.regularMarketPrice;
                    let price = localPrice;
                    const currency = meta.currency;
                    const exchange = meta.fullExchangeName || meta.exchangeName;

                    if (currency && currency !== 'EUR') {
                        try {
                            const fxSymbol = `${currency}EUR=X`;
                            const fxUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${fxSymbol}`;
                            const proxyFxUrl = `https://corsproxy.io/?url=${encodeURIComponent(fxUrl)}`;
                            const fxResponse = await fetch(proxyFxUrl);
                            const fxResult = await fxResponse.json();

                            if (fxResult && fxResult.chart && fxResult.chart.result && fxResult.chart.result.length > 0) {
                                const rate = fxResult.chart.result[0].meta.regularMarketPrice;
                                price = localPrice * rate;
                            }
                        } catch (fxErr) {
                            console.error(`Failed to fetch exchange rate for ${currency} to EUR`, fxErr);
                        }
                    }

                    return { price, localPrice, symbol, exchange, currency };
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
            const linkId = `product-link-${isin}`;
            const tickerId = `ticker-${isin}`;
            const exchangeId = `exchange-${isin}`;
            const currencyId = `currency-${isin}`;
            const localPriceId = `local-price-${isin}`;

            row.innerHTML = `
                <td><a href="https://finance.yahoo.com/lookup?s=${encodeURIComponent(isin)}" target="_blank" id="${escapeHtml(linkId)}" style="color: #2980b9; text-decoration: none;">${escapeHtml(asset.product)}</a></td>
                <td id="${escapeHtml(tickerId)}">...</td>
                <td id="${escapeHtml(exchangeId)}">...</td>
                <td id="${escapeHtml(currencyId)}">...</td>
                <td>${escapeHtml(asset.remainingQty.toString())}</td>
                <td>€${escapeHtml(asset.averageCostBasis.toFixed(2))}</td>
                <td id="${escapeHtml(localPriceId)}">...</td>
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

            fetchLivePrice(isin, asset.product).then(liveData => {
                if (liveData !== null && !isNaN(liveData.price)) {
                    const inputElement = document.getElementById(`price-input-${isin}`);
                    if (inputElement) {
                        inputElement.value = liveData.price.toFixed(2);

                        // Fire an artificial input event to trigger our estimation update
                        inputElement.dispatchEvent(new Event('input'));
                    }

                    const linkElement = document.getElementById(`product-link-${isin}`);
                    if (linkElement && liveData.symbol) {
                        linkElement.href = `https://finance.yahoo.com/quote/${encodeURIComponent(liveData.symbol)}`;
                    }

                    const tickerElement = document.getElementById(`ticker-${isin}`);
                    if (tickerElement) tickerElement.textContent = liveData.symbol;

                    const exchangeElement = document.getElementById(`exchange-${isin}`);
                    if (exchangeElement) exchangeElement.textContent = liveData.exchange;

                    const currencyElement = document.getElementById(`currency-${isin}`);
                    if (currencyElement) currencyElement.textContent = liveData.currency;

                    const localPriceElement = document.getElementById(`local-price-${isin}`);
                    if (localPriceElement) localPriceElement.textContent = `${liveData.localPrice.toFixed(2)} ${liveData.currency}`;
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

        updateOptimizer(currentPrices);
    }

    function updateOptimizer(currentPrices) {
        const today = new Date();
        const currentYear = today.getFullYear();

        // Find existing realized gains/losses for the current year
        const yearSummary = yearSummaries[currentYear] || { grossGain: 0, allowableLoss: 0 };
        const netRealizedGain = yearSummary.grossGain - yearSummary.allowableLoss;

        const EXEMPTION = 1270;
        let remainingExemption = EXEMPTION - netRealizedGain;

        const optimizerResult = document.getElementById('optimizerResult');

        if (remainingExemption <= 0) {
            optimizerResult.textContent = `Your €1,270 exemption for ${currentYear} is already fully utilized.`;
            return;
        }

        let bestAsset = null;
        let bestSharesToSell = 0;
        let bestGain = 0;

        for (const isin in window.currentPortfolio) {
            const asset = window.currentPortfolio[isin];
            if (asset.remainingQty <= 0) continue;

            const currentPrice = currentPrices[isin];
            if (currentPrice <= asset.averageCostBasis) continue; // Only consider profitable assets

            const gainPerShare = currentPrice - asset.averageCostBasis;

            // How many shares can we sell without exceeding the remaining exemption?
            const maxShares = Math.floor(remainingExemption / gainPerShare);

            // We can't sell more than we own
            const sharesToSell = Math.min(maxShares, asset.remainingQty);

            if (sharesToSell > 0) {
                const totalGain = sharesToSell * gainPerShare;

                // Prioritize the asset that gets us closest to the exemption
                if (totalGain > bestGain) {
                    bestGain = totalGain;
                    bestSharesToSell = sharesToSell;
                    bestAsset = asset;
                }
            }
        }

        if (bestAsset) {
            optimizerResult.innerHTML = `To maximize your remaining €${remainingExemption.toFixed(2)} exemption, consider selling <strong>${bestSharesToSell} shares of ${escapeHtml(bestAsset.product)}</strong> for an estimated tax-free gain of €${bestGain.toFixed(2)}.`;
        } else {
            optimizerResult.textContent = `No profitable assets found to utilize your remaining €${remainingExemption.toFixed(2)} exemption.`;
        }
    }
});
