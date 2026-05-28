import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { generateWithRetry } from "../lib/gemini";

// ─── GET AI DEMAND FORECAST ───────────────────────────────────────
export const getDemandForecast = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const { language = "fr", days = "30", from, to } = req.query;

        console.log(`\n🤖 Forecast request:`);
        console.log(`   User: ${user.userId} | Depot: ${user.depotId}`);
        console.log(`   Language: ${language} | Days: ${days}`);
        if (from && to) console.log(`   Custom range: ${from} → ${to}`);

        // ── Calculate date range ──────────────────────────────────
        let startDate: Date;
        let endDate: Date = new Date();
        let periodDays: number;

        if (from && to) {
            startDate = new Date(from as string);
            endDate = new Date(to as string);
            endDate.setHours(23, 59, 59, 999);
            periodDays = Math.ceil(
                (endDate.getTime() - startDate.getTime()) /
                (1000 * 60 * 60 * 24)
            );
        } else {
            periodDays = parseInt(days as string) || 30;
            startDate = new Date();
            startDate.setDate(startDate.getDate() - (periodDays - 1));
            startDate.setHours(0, 0, 0, 0);
        }

        console.log(
            `   Period: ${startDate.toISOString().split("T")[0]} → ${endDate.toISOString().split("T")[0]} (${periodDays} days)`
        );

        // ── Previous period for trend comparison ──────────────────
        const previousStart = new Date(startDate);
        previousStart.setDate(previousStart.getDate() - periodDays);
        const previousEnd = new Date(startDate);

        // ── Contextual date info (gives Gemini seasonal awareness) ─
        const now = new Date();
        const currentMonth = now.toLocaleString("fr-FR", { month: "long" });
        const currentMonthEn = now.toLocaleString("en-US", { month: "long" });
        const dayOfWeek = now.toLocaleString("fr-FR", { weekday: "long" });
        const dayOfWeekEn = now.toLocaleString("en-US", { weekday: "long" });
        const dayOfMonth = now.getDate();
        const isEndOfMonth = dayOfMonth >= 25;
        const isStartOfMonth = dayOfMonth <= 5;
        const isMidMonth = dayOfMonth >= 10 && dayOfMonth <= 20;

        // ── Fetch all products ────────────────────────────────────
        console.log(`\n📦 Fetching products...`);
        const products = await prisma.product.findMany({
            where: { depotId: user.depotId!, isActive: true },
            select: {
                id: true,
                name: true,
                stock: true,
                unit: true,
                lowStockThreshold: true,
                costPrice: true,
                sellingPrice: true,
            },
        });

        console.log(`   Found ${products.length} active products`);

        if (products.length === 0) {
            return res.status(400).json({
                message:
                    language === "fr"
                        ? "Aucun produit trouvé dans ce dépôt"
                        : "No products found in this depot",
            });
        }

        // ── Get sales for selected period ─────────────────────────
        console.log(`\n📊 Fetching sales data...`);
        const recentSales = await prisma.saleItem.findMany({
            where: {
                sale: {
                    depotId: user.depotId!,
                    status: "COMPLETED",
                    createdAt: { gte: startDate, lte: endDate },
                },
            },
            include: {
                product: { select: { name: true, unit: true } },
                sale: { select: { createdAt: true } },
            },
        });

        console.log(`   Current period: ${recentSales.length} sale items`);

        // ── Get sales for previous period (trend) ─────────────────
        const olderSales = await prisma.saleItem.findMany({
            where: {
                sale: {
                    depotId: user.depotId!,
                    status: "COMPLETED",
                    createdAt: { gte: previousStart, lt: previousEnd },
                },
            },
            include: {
                product: { select: { name: true } },
            },
        });

        console.log(`   Previous period: ${olderSales.length} sale items`);

        if (recentSales.length === 0) {
            console.log(`   ⚠️  No sales in current period`);
            return res.status(400).json({
                message:
                    language === "fr"
                        ? "Aucune vente trouvée sur cette période. Essayez une période plus longue."
                        : "No sales found in this period. Try a longer period.",
            });
        }

        // ── Calculate stats per product ───────────────────────────
        console.log(`\n🧮 Calculating product stats...`);
        const productStats = products.map((product) => {
            const productSales = recentSales.filter(
                (s) => s.productId === product.id
            );
            const totalSoldCurrent = productSales.reduce(
                (sum, s) => sum + s.quantity,
                0
            );
            const avgDailySales = totalSoldCurrent / periodDays;
            const daysUntilEmpty =
                avgDailySales > 0
                    ? Math.floor(product.stock / avgDailySales)
                    : 999;

            const olderProductSales = olderSales.filter(
                (s) => s.productId === product.id
            );
            const totalSoldPrevious = olderProductSales.reduce(
                (sum, s) => sum + s.quantity,
                0
            );

            const trend =
                totalSoldPrevious > 0
                    ? ((totalSoldCurrent - totalSoldPrevious) /
                        totalSoldPrevious) *
                    100
                    : totalSoldCurrent > 0
                        ? 100
                        : 0;

            const salesByDay: Record<number, number> = {
                0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0,
            };
            productSales.forEach((s) => {
                const day = new Date(s.sale.createdAt).getDay();
                salesByDay[day] += s.quantity;
            });
            const busiestDay = Object.entries(salesByDay).reduce((a, b) =>
                a[1] > b[1] ? a : b
            )[0];

            const recommendedRestock = Math.max(
                0,
                Math.ceil(avgDailySales * periodDays) - product.stock
            );

            const revenueThisPeriod = productSales.reduce(
                (sum, s) => sum + s.quantity * s.unitPrice,
                0
            );
            const profitThisPeriod = productSales.reduce(
                (sum, s) => sum + s.profit,
                0
            );

            // ── Margin analysis ───────────────────────────────────
            const marginPercent =
                product.sellingPrice > 0
                    ? ((product.sellingPrice - product.costPrice) /
                        product.sellingPrice) *
                    100
                    : 0;

            return {
                id: product.id,
                name: product.name,
                unit: product.unit,
                currentStock: product.stock,
                threshold: product.lowStockThreshold,
                totalSoldCurrentPeriod: totalSoldCurrent,
                totalSoldPreviousPeriod: totalSoldPrevious,
                avgDailySales: parseFloat(avgDailySales.toFixed(2)),
                daysUntilEmpty,
                trendPercent: parseFloat(trend.toFixed(1)),
                recommendedRestock,
                busiestDay: parseInt(busiestDay),
                revenueThisPeriod,
                profitThisPeriod,
                revenuePerUnit: product.sellingPrice,
                costPerUnit: product.costPrice,
                profitPerUnit: product.sellingPrice - product.costPrice,
                marginPercent: parseFloat(marginPercent.toFixed(1)),
            };
        });

        const activeProducts = productStats.filter(
            (p) => p.totalSoldCurrentPeriod > 0
        );
        const urgentProducts = [...activeProducts].sort(
            (a, b) => a.daysUntilEmpty - b.daysUntilEmpty
        );

        // ── High margin but low velocity (pricing opportunity) ────
        const highMarginLowVolume = productStats
            .filter((p) => p.marginPercent >= 30 && p.avgDailySales < 1)
            .map((p) => p.name);

        // ── Low margin high volume (margin risk) ──────────────────
        const lowMarginHighVolume = productStats
            .filter((p) => p.marginPercent < 15 && p.avgDailySales >= 2)
            .map((p) => p.name);

        console.log(
            `   Active products (with sales): ${activeProducts.length}/${products.length}`
        );

        const totalRevenuePeriod = recentSales.reduce(
            (sum, s) => sum + s.quantity * s.unitPrice,
            0
        );
        const totalProfitPeriod = recentSales.reduce(
            (sum, s) => sum + s.profit,
            0
        );
        const totalUnitsSold = recentSales.reduce(
            (sum, s) => sum + s.quantity,
            0
        );
        const overallMarginPercent =
            totalRevenuePeriod > 0
                ? ((totalProfitPeriod / totalRevenuePeriod) * 100).toFixed(1)
                : "0";

        console.log(
            `   Total revenue: ${totalRevenuePeriod.toLocaleString()} FCFA`
        );
        console.log(
            `   Total profit: ${totalProfitPeriod.toLocaleString()} FCFA`
        );
        console.log(`   Total units sold: ${totalUnitsSold}`);
        console.log(`   Overall margin: ${overallMarginPercent}%`);

        // ── Day labels ────────────────────────────────────────────
        const dayNames =
            language === "fr"
                ? [
                    "Dimanche",
                    "Lundi",
                    "Mardi",
                    "Mercredi",
                    "Jeudi",
                    "Vendredi",
                    "Samedi",
                ]
                : [
                    "Sunday",
                    "Monday",
                    "Tuesday",
                    "Wednesday",
                    "Thursday",
                    "Friday",
                    "Saturday",
                ];

        const periodLabel =
            language === "fr"
                ? `${periodDays} derniers jours`
                : `last ${periodDays} days`;

        // ── Build product summary for Gemini ──────────────────────
        const productSummary = urgentProducts
            .slice(0, 12)
            .map((p) => {
                const urgency =
                    p.daysUntilEmpty <= 3
                        ? language === "fr"
                            ? "CRITIQUE"
                            : "CRITICAL"
                        : p.daysUntilEmpty <= 7
                            ? "URGENT"
                            : "OK";

                return (
                    `- ${p.name}: ` +
                    `stock=${p.currentStock} ${p.unit}, ` +
                    `vendu_periode=${p.totalSoldCurrentPeriod}, ` +
                    `vendu_periode_precedente=${p.totalSoldPreviousPeriod}, ` +
                    `moy_jour=${p.avgDailySales}/jour, ` +
                    `epuise_dans=${p.daysUntilEmpty === 999 ? "N/A" : p.daysUntilEmpty + " jours"}, ` +
                    `tendance=${p.trendPercent > 0 ? "+" : ""}${p.trendPercent}%, ` +
                    `jour_fort=${dayNames[p.busiestDay]}, ` +
                    `reappro=${p.recommendedRestock} ${p.unit}, ` +
                    `marge=${p.marginPercent}%, ` +
                    `revenu=${p.revenueThisPeriod.toLocaleString()} FCFA, ` +
                    `statut=${urgency}`
                );
            })
            .join("\n");

        // ── Contextual signals for Gemini ─────────────────────────
        const contextualSignals =
            language === "fr"
                ? [
                    `Nous sommes le ${dayOfWeek} ${dayOfMonth} ${currentMonth}.`,
                    isEndOfMonth
                        ? "Fin de mois : les clients ont souvent reçu leurs salaires. C'est le bon moment pour pousser les produits premium et augmenter les volumes."
                        : isStartOfMonth
                            ? "Début de mois : les gens ont de l'argent frais. Période favorable pour les achats importants et en gros."
                            : isMidMonth
                                ? "Mi-mois : période neutre, les clients sont en mode routine. Misez sur la fidélité et les offres groupées."
                                : "",
                ]
                    .filter(Boolean)
                    .join(" ")
                : [
                    `Today is ${dayOfWeekEn}, ${currentMonthEn} ${dayOfMonth}.`,
                    isEndOfMonth
                        ? "End of month: customers typically have received salaries. Good moment to push premium products and increase volumes."
                        : isStartOfMonth
                            ? "Start of month: people have fresh cash. Favorable period for larger purchases and bulk buying."
                            : isMidMonth
                                ? "Mid-month: neutral period, customers are in routine mode. Focus on loyalty and bundled offers."
                                : "",
                ]
                    .filter(Boolean)
                    .join(" ");

        // ── Build prompt ──────────────────────────────────────────
        const prompt =
            language === "fr"
                ? `Tu es le conseiller business personnel d'un gérant de dépôt de boissons au Cameroun. Tu combines l'expertise d'un analyste de données, d'un coach commercial et d'un expert en marketing de terrain africain. Tu parles directement au gérant, avec chaleur, franchise et précision — comme un ami expert qui veut vraiment que son business prospère.

CONTEXTE TEMPOREL:
${contextualSignals}

SANTÉ FINANCIÈRE DU DÉPÔT (${periodLabel}):
- Revenu total: ${totalRevenuePeriod.toLocaleString()} FCFA
- Bénéfice total: ${totalProfitPeriod.toLocaleString()} FCFA
- Marge globale: ${overallMarginPercent}%
- Unités vendues: ${totalUnitsSold}
- Produits actifs: ${activeProducts.length}/${products.length}
- Produits à forte marge mais faible vente: ${highMarginLowVolume.join(", ") || "aucun"}
- Produits à faible marge mais fort volume: ${lowMarginHighVolume.join(", ") || "aucun"}

DONNÉES PAR PRODUIT (triés par urgence):
${productSummary}

MISSION: Analyse ces données et donne des conseils concrets, pratiques et adaptés au contexte camerounais. Pense aux réalités du terrain: marchés locaux, concurrence des dépôts voisins, comportement des clients en fin/début de mois, opportunités de vente groupée, fidélisation.

Réponds en JSON valide UNIQUEMENT (pas de texte avant ou après). Structure exacte:
{
  "summary": "Résumé percutant en 2-3 phrases qui parle directement au gérant. Mentionne les chiffres clés et donne le ton général (positif/préoccupant/à surveiller).",
  
  "weeklyRevenueForecast": nombre_entier_en_FCFA,
  
  "businessHealthScore": {
    "score": nombre_entre_0_et_100,
    "label": "Excellent | Bon | À surveiller | Préoccupant | Critique",
    "reason": "Une phrase expliquant pourquoi ce score. Sois direct."
  },
  
  "weeklyFocus": {
    "title": "La priorité de cette semaine en 5 mots max",
    "description": "2-3 phrases concrètes sur QUOI faire exactement cette semaine et POURQUOI c'est urgent ou opportun maintenant.",
    "icon": "🎯"
  },
  
  "topInsights": [
    "Insight 1 avec chiffres précis",
    "Insight 2 avec chiffres précis",
    "Insight 3 avec chiffres précis"
  ],
  
  "urgentRestocks": [
    {
      "productName": "nom exact du produit",
      "daysLeft": nombre_entier,
      "recommendedQuantity": nombre_entier,
      "reason": "Raison courte et précise avec chiffres"
    }
  ],
  
  "decliningProducts": [
    {
      "productName": "nom exact",
      "trendPercent": nombre_negatif,
      "suggestion": "Suggestion concrète adaptée au marché camerounais"
    }
  ],
  
  "growingProducts": [
    {
      "productName": "nom exact",
      "trendPercent": nombre_positif,
      "suggestion": "Comment capitaliser sur cette tendance maintenant"
    }
  ],
  
  "marketingTips": [
    {
      "title": "Titre court de l'action",
      "description": "Action marketing concrète et réaliste pour un dépôt au Cameroun. Pense: WhatsApp, fidélité, vente groupée, prix psychologiques, partenariats locaux, clients professionnels (bars, restaurants, hôtels), promotion fin de semaine, etc.",
      "impact": "Élevé | Moyen | Rapide",
      "effort": "Faible | Moyen | Élevé"
    }
  ],
  
  "pricingOpportunities": [
    {
      "productName": "nom exact",
      "type": "Augmenter prix | Réduire prix | Offre groupée | Prix psychologique",
      "suggestion": "Conseil de prix précis avec justification basée sur la marge et le volume réel"
    }
  ],
  
  "bestSellingDay": "nom du jour le plus actif globalement",
  
  "actionPlan": [
    "Action prioritaire 1 — concrète, faisable cette semaine",
    "Action prioritaire 2 — concrète, faisable cette semaine",
    "Action prioritaire 3 — concrète, faisable cette semaine"
  ]
}`
                : `You are the personal business advisor of a beverage depot manager in Cameroon. You combine the expertise of a data analyst, a sales coach, and an African field marketing expert. You speak directly to the manager, with warmth, frankness and precision — like a knowledgeable friend who genuinely wants their business to thrive.

TEMPORAL CONTEXT:
${contextualSignals}

DEPOT FINANCIAL HEALTH (${periodLabel}):
- Total revenue: ${totalRevenuePeriod.toLocaleString()} FCFA
- Total profit: ${totalProfitPeriod.toLocaleString()} FCFA
- Overall margin: ${overallMarginPercent}%
- Units sold: ${totalUnitsSold}
- Active products: ${activeProducts.length}/${products.length}
- High margin but low-selling products: ${highMarginLowVolume.join(", ") || "none"}
- Low margin but high-volume products: ${lowMarginHighVolume.join(", ") || "none"}

PRODUCT DATA (sorted by urgency):
${productSummary}

MISSION: Analyze this data and give concrete, practical advice adapted to the Cameroonian context. Think about ground realities: local markets, competition from nearby depots, customer behavior at end/start of month, bulk sale opportunities, loyalty building.

Reply in valid JSON ONLY (no text before or after). Exact structure:
{
  "summary": "Punchy 2-3 sentence summary speaking directly to the manager. Mention key numbers and set the overall tone (positive/concerning/watch out).",
  
  "weeklyRevenueForecast": integer_in_FCFA,
  
  "businessHealthScore": {
    "score": number_between_0_and_100,
    "label": "Excellent | Good | Watch out | Concerning | Critical",
    "reason": "One sentence explaining why this score. Be direct."
  },
  
  "weeklyFocus": {
    "title": "This week's priority in 5 words max",
    "description": "2-3 concrete sentences on WHAT to do exactly this week and WHY it is urgent or opportune right now.",
    "icon": "🎯"
  },
  
  "topInsights": [
    "Insight 1 with precise numbers",
    "Insight 2 with precise numbers",
    "Insight 3 with precise numbers"
  ],
  
  "urgentRestocks": [
    {
      "productName": "exact product name",
      "daysLeft": integer,
      "recommendedQuantity": integer,
      "reason": "Short precise reason with numbers"
    }
  ],
  
  "decliningProducts": [
    {
      "productName": "exact name",
      "trendPercent": negative_number,
      "suggestion": "Concrete suggestion adapted to the Cameroonian market"
    }
  ],
  
  "growingProducts": [
    {
      "productName": "exact name",
      "trendPercent": positive_number,
      "suggestion": "How to capitalize on this trend right now"
    }
  ],
  
  "marketingTips": [
    {
      "title": "Short action title",
      "description": "Concrete and realistic marketing action for a depot in Cameroon. Think: WhatsApp, loyalty, bundle deals, psychological pricing, local partnerships, professional clients (bars, restaurants, hotels), weekend promotions, etc.",
      "impact": "High | Medium | Quick win",
      "effort": "Low | Medium | High"
    }
  ],
  
  "pricingOpportunities": [
    {
      "productName": "exact name",
      "type": "Increase price | Reduce price | Bundle offer | Psychological price",
      "suggestion": "Precise pricing advice with justification based on actual margin and volume"
    }
  ],
  
  "bestSellingDay": "most active day name globally",
  
  "actionPlan": [
    "Priority action 1 — concrete, doable this week",
    "Priority action 2 — concrete, doable this week",
    "Priority action 3 — concrete, doable this week"
  ]
}`;

        // ── Call Gemini with retry ─────────────────────────────────
        console.log(`\n🤖 Calling Gemini AI...`);
        const startTime = Date.now();

        let forecast: any;

        try {
            const responseText = await generateWithRetry(prompt, 3, 2000);
            const elapsed = Date.now() - startTime;
            console.log(`   ✅ Gemini responded in ${elapsed}ms`);
            console.log(`   Response length: ${responseText.length} chars`);

            // Clean response
            const cleanJson = responseText
                .replace(/```json\n?/g, "")
                .replace(/```\n?/g, "")
                .trim();

            try {
                forecast = JSON.parse(cleanJson);
                console.log(`   ✅ JSON parsed successfully`);
                console.log(`   Keys: ${Object.keys(forecast).join(", ")}`);
            } catch (parseErr) {
                console.error(`   ❌ JSON parse failed`);
                console.error(
                    `   Raw response: ${cleanJson.substring(0, 200)}...`
                );
                forecast = _buildFallbackForecast(
                    language as string,
                    totalRevenuePeriod,
                    totalProfitPeriod,
                    overallMarginPercent,
                    periodDays,
                    urgentProducts,
                    highMarginLowVolume,
                    lowMarginHighVolume
                );
            }
        } catch (geminiError: any) {
            console.error(
                `   ❌ Gemini failed: ${geminiError.status} ${geminiError.message}`
            );

            if (geminiError.status === 503) {
                return res.status(503).json({
                    message:
                        language === "fr"
                            ? "Le service IA est temporairement surchargé. Réessayez dans 1-2 minutes."
                            : "AI service is temporarily overloaded. Please retry in 1-2 minutes.",
                    retryAfter: 120,
                });
            }

            if (geminiError.status === 429) {
                return res.status(429).json({
                    message:
                        language === "fr"
                            ? "Limite de requêtes Gemini atteinte. Réessayez dans quelques minutes."
                            : "Gemini rate limit reached. Please retry in a few minutes.",
                    retryAfter: 60,
                });
            }

            console.log(`   ⚠️  Using fallback forecast`);
            forecast = _buildFallbackForecast(
                language as string,
                totalRevenuePeriod,
                totalProfitPeriod,
                overallMarginPercent,
                periodDays,
                urgentProducts,
                highMarginLowVolume,
                lowMarginHighVolume
            );
        }

        console.log(`\n✅ Forecast complete — sending response\n`);

        return res.status(200).json({
            forecast,
            meta: {
                periodDays,
                startDate: startDate.toISOString().split("T")[0],
                endDate: endDate.toISOString().split("T")[0],
                language,
                totalProducts: products.length,
                activeProducts: activeProducts.length,
                totalRevenuePeriod,
                totalProfitPeriod,
                totalUnitsSold,
                overallMarginPercent,
            },
            rawStats: urgentProducts,
        });
    } catch (error: any) {
        console.error(`\n❌ Forecast controller error:`, error);
        return res.status(500).json({
            message: "Server error",
            detail: error.message,
        });
    }
};

// ── Fallback forecast (no AI) ─────────────────────────────────────
function _buildFallbackForecast(
    language: string,
    totalRevenuePeriod: number,
    totalProfitPeriod: number,
    overallMarginPercent: string,
    periodDays: number,
    urgentProducts: any[],
    highMarginLowVolume: string[],
    lowMarginHighVolume: string[]
) {
    console.log(
        `   Building fallback forecast for ${urgentProducts.length} products`
    );

    const dailyRevenue = Math.round(totalRevenuePeriod / periodDays);
    const marginNum = parseFloat(overallMarginPercent);
    const healthScore =
        marginNum >= 25 && urgentProducts.filter((p) => p.daysUntilEmpty <= 7).length === 0
            ? 75
            : marginNum >= 15
                ? 55
                : 35;

    return {
        summary:
            language === "fr"
                ? `Analyse IA temporairement indisponible. Sur les ${periodDays} derniers jours, votre dépôt a généré ${totalRevenuePeriod.toLocaleString()} FCFA de revenu avec une marge de ${overallMarginPercent}%. Consultez les données détaillées ci-dessous.`
                : `AI analysis temporarily unavailable. Over the last ${periodDays} days, your depot generated ${totalRevenuePeriod.toLocaleString()} FCFA in revenue with a ${overallMarginPercent}% margin. See the detailed data below.`,

        weeklyRevenueForecast: Math.round(dailyRevenue * 7),

        businessHealthScore: {
            score: healthScore,
            label:
                language === "fr"
                    ? healthScore >= 70
                        ? "Bon"
                        : healthScore >= 50
                            ? "À surveiller"
                            : "Préoccupant"
                    : healthScore >= 70
                        ? "Good"
                        : healthScore >= 50
                            ? "Watch out"
                            : "Concerning",
            reason:
                language === "fr"
                    ? `Marge globale de ${overallMarginPercent}% sur la période. Activez l'IA Gemini pour une analyse complète.`
                    : `Overall margin of ${overallMarginPercent}% for the period. Enable Gemini AI for a full analysis.`,
        },

        weeklyFocus: {
            title:
                language === "fr"
                    ? "Réapprovisionner les urgences"
                    : "Restock urgent items",
            description:
                language === "fr"
                    ? `${urgentProducts.filter((p) => p.daysUntilEmpty <= 7).length} produit(s) risquent d'être épuisés cette semaine. Priorisez ces réapprovisionnements avant de vous concentrer sur d'autres actions.`
                    : `${urgentProducts.filter((p) => p.daysUntilEmpty <= 7).length} product(s) risk running out this week. Prioritize these restocks before focusing on other actions.`,
            icon: "🎯",
        },

        topInsights:
            language === "fr"
                ? [
                    `${urgentProducts.length} produit(s) actif(s) sur ${urgentProducts.length} — revenu moyen journalier: ${dailyRevenue.toLocaleString()} FCFA`,
                    `Marge globale: ${overallMarginPercent}% — bénéfice total: ${totalProfitPeriod.toLocaleString()} FCFA sur la période`,
                    highMarginLowVolume.length > 0
                        ? `Produits à fort potentiel non exploités: ${highMarginLowVolume.slice(0, 2).join(", ")}`
                        : "Activez l'IA Gemini pour des insights personnalisés sur vos produits",
                ]
                : [
                    `${urgentProducts.length} active product(s) — average daily revenue: ${dailyRevenue.toLocaleString()} FCFA`,
                    `Overall margin: ${overallMarginPercent}% — total profit: ${totalProfitPeriod.toLocaleString()} FCFA for the period`,
                    highMarginLowVolume.length > 0
                        ? `High-potential underperforming products: ${highMarginLowVolume.slice(0, 2).join(", ")}`
                        : "Enable Gemini AI for personalized product insights",
                ],

        urgentRestocks: urgentProducts
            .filter((p) => p.daysUntilEmpty <= 7)
            .map((p) => ({
                productName: p.name,
                daysLeft: p.daysUntilEmpty,
                recommendedQuantity: p.recommendedRestock,
                reason:
                    language === "fr"
                        ? `Stock actuel: ${p.currentStock} ${p.unit} — épuisé dans ${p.daysUntilEmpty} jour(s)`
                        : `Current stock: ${p.currentStock} ${p.unit} — runs out in ${p.daysUntilEmpty} day(s)`,
            })),

        decliningProducts: urgentProducts
            .filter((p) => p.trendPercent < -10)
            .map((p) => ({
                productName: p.name,
                trendPercent: p.trendPercent,
                suggestion:
                    language === "fr"
                        ? "Identifiez si c'est une baisse saisonnière ou une perte de clientèle. Envisagez une promotion groupée."
                        : "Identify if this is a seasonal dip or customer loss. Consider a bundle promotion.",
            })),

        growingProducts: urgentProducts
            .filter((p) => p.trendPercent > 10)
            .map((p) => ({
                productName: p.name,
                trendPercent: p.trendPercent,
                suggestion:
                    language === "fr"
                        ? "Assurez-vous d'avoir un stock suffisant pour ne pas rater les ventes sur ce produit porteur."
                        : "Make sure you have enough stock to avoid missing sales on this strong performer.",
            })),

        marketingTips:
            language === "fr"
                ? [
                    {
                        title: "Groupe WhatsApp clients",
                        description:
                            "Créez un groupe WhatsApp avec vos meilleurs clients. Envoyez les promotions du jour et les nouveaux arrivages directement. C'est gratuit et très efficace au Cameroun.",
                        impact: "Élevé",
                        effort: "Faible",
                    },
                    {
                        title: "Carte de fidélité simple",
                        description:
                            "Proposez: achetez 10 casiers, obtenez 1 gratuit. Notez sur un carnet ou une fiche. Ça fidélise sans logiciel complexe.",
                        impact: "Moyen",
                        effort: "Faible",
                    },
                ]
                : [
                    {
                        title: "WhatsApp customer group",
                        description:
                            "Create a WhatsApp group with your best customers. Send daily deals and new stock arrivals directly. It's free and very effective.",
                        impact: "High",
                        effort: "Low",
                    },
                    {
                        title: "Simple loyalty card",
                        description:
                            "Offer: buy 10 crates, get 1 free. Track it in a notebook or card. Builds loyalty without complex software.",
                        impact: "Medium",
                        effort: "Low",
                    },
                ],

        pricingOpportunities:
            highMarginLowVolume.length > 0
                ? highMarginLowVolume.slice(0, 2).map((name) => ({
                    productName: name,
                    type:
                        language === "fr"
                            ? "Offre groupée"
                            : "Bundle offer",
                    suggestion:
                        language === "fr"
                            ? "Forte marge mais faibles ventes. Groupez avec un produit populaire pour augmenter la visibilité et l'écoulement."
                            : "High margin but low sales. Bundle with a popular product to increase visibility and turnover.",
                }))
                : [],

        bestSellingDay: "",

        actionPlan:
            language === "fr"
                ? [
                    "Réapprovisionner immédiatement les produits dont le stock tombe sous le seuil critique",
                    "Contacter vos 5 meilleurs clients cette semaine pour leur proposer une commande groupée",
                    "Activer l'IA Gemini pour des recommandations marketing personnalisées basées sur vos vraies données",
                ]
                : [
                    "Immediately restock products whose stock falls below the critical threshold",
                    "Contact your top 5 customers this week to offer them a bulk order deal",
                    "Enable Gemini AI for personalized marketing recommendations based on your real data",
                ],
    };
}