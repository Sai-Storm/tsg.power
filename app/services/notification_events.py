from .notifications import _notify_many, users_with_permission


def notify_assignment(service, newly_assigned_ids=(), removed_ids=(), event_key=None):
    added, removed = set(newly_assigned_ids), set(removed_ids)
    if not added and not removed:
        return 0
    recipients = added | removed
    reassigned = bool(removed)
    current_ids = {assignment.user_id for assignment in service.active_assignments}
    event_key = event_key or "assignment:" + ",".join(map(str, sorted(current_ids)))
    title = "Job reassigned" if reassigned else "Job assigned"
    count = 0
    for recipient_id in recipients:
        message = (f"{service.service_id} assignment updated. You are no longer assigned."
                   if recipient_id in removed and recipient_id not in added
                   else f"{service.service_id} has been assigned to you.")
        count += _notify_many([recipient_id], "job_reassigned" if reassigned else "job_assigned", title, message,
                              entity_type="service_request", entity_id=service.id, dedupe_key=event_key)
    return count


def notify_urgent_request(service, event_key=None):
    if not service.priority or service.priority.code != "urgent":
        return 0
    recipient_ids = {user.id for user in users_with_permission("service.assign")}
    event_key = event_key or f"urgent-service:{service.id}"
    return _notify_many(recipient_ids, "urgent_request", "Urgent service request",
                        f"{service.service_id} requires urgent attention.",
                        entity_type="service_request", entity_id=service.id, dedupe_key=event_key)


def notify_material_decision(requirement, decision):
    if decision not in ("approved", "rejected"):
        raise ValueError("Material decision must be approved or rejected.")
    service = requirement.service
    recipients = {requirement.requested_by_id}
    recipients.update(assignment.user_id for assignment in service.active_assignments)
    return _notify_many(recipients, f"material_{decision}", f"Material request {decision}",
                        f"{requirement.description} for {service.service_id} was {decision}.",
                        entity_type="service_requirement", entity_id=requirement.id,
                        dedupe_key=f"material:{requirement.id}:{decision}")


def notify_low_stock(item, event_key=None):
    if not item.is_active or not item.is_low:
        return 0
    recipient_ids = {user.id for user in users_with_permission("inventory.manage")}
    event_key = event_key or f"low-stock:{item.id}:threshold"
    return _notify_many(recipient_ids, "low_stock", "Inventory is low",
                        f"{item.name} is at or below its minimum stock level.",
                        entity_type="inventory_item", entity_id=item.id, dedupe_key=event_key)


def notify_completion(service, event_key=None):
    recipients = {service.created_by_id}
    recipients.update(assignment.user_id for assignment in service.active_assignments)
    recipients.update(user.id for user in users_with_permission("service.assign"))
    event_key = event_key or f"completion:{service.id}"
    return _notify_many(recipients, "job_completed", "Service job completed",
                        f"{service.service_id} has been marked completed.",
                        entity_type="service_request", entity_id=service.id, dedupe_key=event_key)


def notify_estimate_awaiting_approval(estimate):
    status = getattr(estimate, "status", "draft")
    if status != "draft":
        return 0
    recipients = {user.id for user in users_with_permission("estimate.approve")
                  if user.id != estimate.created_by_id}
    return _notify_many(recipients, "estimate_awaiting_approval", "Estimate awaiting approval",
                        f"Estimate v{estimate.version} for {estimate.service.service_id} is ready for approval.",
                        entity_type="service_estimate", entity_id=estimate.id,
                        dedupe_key=f"estimate-awaiting-approval:{estimate.id}")
