import { listMembers, getMember, createMember, updateMember, deleteMember } from '../../services/members.js';
import { auditLog } from '../../utils/audit.js';

export async function list(req, res) {
  const { limit = 100, offset = 0, q = '' } = req.query;
  const rows = await listMembers({ limit: Number(limit), offset: Number(offset), q });
  res.json(rows);
}

export async function get(req, res) {
  const member = await getMember(req.params.id);
  res.json(member);
}

export async function create(req, res) {
  const member = await createMember(req.validatedBody);
  await auditLog({ actorId: req.user.id, action: 'create_member', resourceType: 'member', resourceId: member.id });
  res.status(201).json(member);
}

export async function update(req, res) {
  const member = await updateMember(req.params.id, req.validatedBody);
  await auditLog({ actorId: req.user.id, action: 'update_member', resourceType: 'member', resourceId: member.id });
  res.json(member);
}

export async function remove(req, res) {
  const result = await deleteMember(req.params.id);
  await auditLog({ actorId: req.user.id, action: 'delete_member', resourceType: 'member', resourceId: req.params.id });
  res.json(result);
}
