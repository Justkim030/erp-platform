# Physical supervisor verification — architecture requirements

**Status:** requirement confirmed by Eagle One; **design specified here, not yet
implemented** (implementation belongs to the attendance stage that introduces
exception workflows and sessions). GPS verification alone must never be
represented as proof that a supervisor physically observed an employee.

## 1. The business requirement

Supervisors must physically verify employees' presence. This is a mandatory part of
the future attendance workflow. It is a **separate form of evidence** from GPS:

| Evidence                  | Source                    | What it proves                                       | What it cannot prove                                                |
| ------------------------- | ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| GPS reading               | Employee's device         | Device was (probably) near the site                  | That the _employee_ was there; device may be spoofed or left behind |
| Geofence evaluation       | Server logic              | Consistency of the reading with the site boundary    | Presence; it is a rule over the reading                             |
| Staff-network address     | Server observation        | A device on the company network made the request     | Which person; NAT is shared                                         |
| **Physical verification** | **Supervisor, in person** | A responsible human confirmed the person was present | Nothing about time between visits — it is point-in-time             |

The three automated signals are corroborating evidence. Only physical verification
is direct human attestation. The system must keep them distinct forever: no report,
dashboard or flag may derive "physically verified" from GPS or network checks.

## 2. Integration point in the attendance lifecycle

Verification records attach to an **attendance session** (the open/closed span
introduced in Stage 3), not to individual clock events:

```
clock-in event ──opens──> attendance session <──references── physical_verifications
                              │                                (0..n per session)
work reports ─────────────────┘
clock-out event ──closes──────┘
```

Rationale: a supervisor may verify a worker at any point during the working day
(once or several times), and the record must survive even if that day's clock
events are later corrected through the exception flow. Attaching to the session
gives the record a stable anchor that is independent of the raw event stream.

A verification may be performed:

- proactively during the day (routine patrols),
- as the resolution of a flagged clock-in/clock-out (review outcome "verified on site"),
- as part of an exception review (e.g. GPS-unavailable worker verified visually).

## 3. Record contract (future table: `physical_verifications`)

| Field            | Type                          | Notes                                                                                                                         |
| ---------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `id`             | uuid                          |                                                                                                                               |
| `tenant_id`      | uuid                          | from the verifying supervisor's token, never from input                                                                       |
| `session_id`     | uuid FK → attendance_sessions | nullable for pre-session legacy days                                                                                          |
| `event_id`       | uuid FK → attendance_events   | nullable; set when the verification resolves a specific flagged event                                                         |
| `worker_id`      | uuid                          | the employee who was verified (denormalised for query convenience; must match the session's worker)                           |
| `supervisor_id`  | uuid                          | the authenticated supervisor who performed the verification — the actor from the token                                        |
| `verified_at`    | timestamptz                   | **server-generated**, never client-supplied                                                                                   |
| `outcome`        | text                          | `confirmed` (supervisor physically saw the employee present) or `not_found` (employee could not be located) — no other values |
| `method`         | text                          | `in_person` initially; extensible later (e.g. `qr_scan` when gate codes are reintroduced)                                     |
| `note`           | text                          | optional supervisor note                                                                                                      |
| `audit_event_id` | uuid FK → audit_events        | the audit row is written in the same transaction                                                                              |
| `created_at`     | timestamptz                   |                                                                                                                               |

**No coordinates are required** for a verification. The supervisor's own location
may be recorded for context but must never be a precondition of the record.

## 4. Authorisation rules

- Only `supervisor`, `management`, `admin` may create verification records.
- A supervisor may record a verification **only for workers currently assigned to
  them** (same object-level check as the existing review endpoint). Management and
  admin may verify any worker in the tenant.
- A supervisor can never verify their own attendance (self-attestation is not
  verification).
- The worker cannot create, edit or delete verification records.
- Records are append-only: disputes are resolved by adding a new record with a new
  outcome and an audit entry, never by editing the original.

## 5. Missing, rejected and disputed verification

- **Missing:** a session with no verification record is simply _not verified_ —
  it must be displayed as such (e.g. "not physically verified"), never as verified.
  Whether a missing verification _blocks_ anything (payroll, review closure) is a
  business decision for Eagle One — see open questions.
- **Rejected/not found:** `outcome = 'not_found'` is a normal, retained record. It
  flags the session for management attention and appears in the review queue.
- **Disputed:** a worker may challenge a verification through the exception
  workflow (Stage 3+). The dispute is a separate exception record referencing the
  verification; the original record is never altered.

## 6. Unresolved operational details (Eagle One to decide before implementation)

1. **Frequency:** is one verification per worker per day required, per shift, or
   spot-check only?
2. **Trigger:** who decides when a physical check happens — supervisor judgement,
   flagged GPS entries only, or a required daily checklist?
3. **Escalation:** what happens after a `not_found` result? (Warning? Management
   notification? Payroll consequence?)
4. **Retroactive window:** can a supervisor record a verification for a worker they
   saw earlier in the day, or must it be recorded at the moment of observation?
5. **Device support:** do supervisors verify from their phones in the field
   (assumed yes) or must it be done from a desk?

These are policy questions, not technical ones — the record contract above
accommodates any of the answers.
