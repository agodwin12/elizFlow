/**
 * Central subscription/access logic shared by login and the route guard.
 *
 * A depot is considered blocked (cannot use the app) when:
 *  - it is soft-deleted / deactivated (isActive = false), OR
 *  - subscriptionStatus is BLOCKED or EXPIRED, OR
 *  - subscriptionEndsAt has passed and the grace period is also exhausted.
 *
 * During the grace period (subscriptionEndsAt < now <= endsAt + graceDays) the
 * depot is PAST_DUE: still allowed in, but flagged so the app can nag them.
 */
export interface DepotSubscriptionFields {
    isActive: boolean;
    subscriptionStatus: string;
    subscriptionEndsAt: Date | null;
    trialEndsAt: Date | null;
    gracePeriodDays: number;
    blockedReason: string | null;
}

export interface SubscriptionDecision {
    blocked: boolean;
    pastDue: boolean;
    status: string;
    reason: string | null;
    message: string;
}

const BLOCKED_MESSAGE =
    "Votre abonnement est inactif. Veuillez vous abonner pour continuer à utiliser l'application.";

export function evaluateSubscription(
    depot: DepotSubscriptionFields,
    now: Date = new Date()
): SubscriptionDecision {
    if (!depot.isActive) {
        return {
            blocked: true,
            pastDue: false,
            status: "BLOCKED",
            reason: depot.blockedReason ?? "Compte désactivé",
            message: BLOCKED_MESSAGE,
        };
    }

    if (depot.subscriptionStatus === "BLOCKED") {
        return {
            blocked: true,
            pastDue: false,
            status: "BLOCKED",
            reason: depot.blockedReason ?? "Abonnement bloqué",
            message: BLOCKED_MESSAGE,
        };
    }

    if (depot.subscriptionStatus === "EXPIRED") {
        return {
            blocked: true,
            pastDue: false,
            status: "EXPIRED",
            reason: "Abonnement expiré",
            message: BLOCKED_MESSAGE,
        };
    }

    // Trial: if a trial end date exists and passed with no paid subscription, block.
    if (depot.subscriptionStatus === "TRIAL" && depot.trialEndsAt) {
        if (now > depot.trialEndsAt) {
            return {
                blocked: true,
                pastDue: false,
                status: "EXPIRED",
                reason: "Période d'essai terminée",
                message:
                    "Votre période d'essai est terminée. Veuillez vous abonner pour continuer.",
            };
        }
    }

    // Active/paid: check the paid period end + grace window.
    if (depot.subscriptionEndsAt) {
        const graceMs = (depot.gracePeriodDays || 0) * 24 * 60 * 60 * 1000;
        const hardEnd = new Date(depot.subscriptionEndsAt.getTime() + graceMs);
        if (now > hardEnd) {
            return {
                blocked: true,
                pastDue: false,
                status: "EXPIRED",
                reason: "Abonnement expiré",
                message: BLOCKED_MESSAGE,
            };
        }
        if (now > depot.subscriptionEndsAt) {
            return {
                blocked: false,
                pastDue: true,
                status: "PAST_DUE",
                reason: "Paiement en retard",
                message:
                    "Votre abonnement a expiré. Merci de renouveler avant la fin de la période de grâce.",
            };
        }
    }

    return {
        blocked: false,
        pastDue: false,
        status: depot.subscriptionStatus,
        reason: null,
        message: "OK",
    };
}
