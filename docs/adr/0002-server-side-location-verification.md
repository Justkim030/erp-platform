# ADR 0002: Server-side location verification replaces the gate QR code

**Status:** accepted for v0.1 (decision by the product owner).

**Decision.** Clock-in and clock-out are decided on the server from the browser's location reading, the site boundary, accuracy, optional staff-network address and plausibility rules. The rotating gate QR code is not part of version 1.

**Why.** Simpler rollout (no gate hardware, nothing to print), less friction at the entrance, and location is already needed to show supervisors where each entry happened.

**Consequences.** The QR code was the only check that required standing at the gate. A browser's location can be faked and the server cannot see through that, so the design leans on what the server observes itself (the staff network's public IP), review by humans for doubtful entries, an audit trail, and tuning from real data. Exact coordinates are stored so supervisors can see them on a map, which makes retention (default 90 days) and audited access essential. A stronger signal (QR, passkey-registered phone, native app) can be added later behind the same decision function.
