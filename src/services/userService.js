import prisma from "../config/prisma.js";

function getEmail(user) {
  const primary = user.email_addresses?.find((entry) => entry.id === user.primary_email_address_id);
  const email = primary?.email_address ?? user.email_addresses?.[0]?.email_address;
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function getFullName(user) {
  const name = typeof user.public_metadata?.full_name === "string"
    ? user.public_metadata.full_name.trim()
    : [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return (name || user.username || getEmail(user)).slice(0, 150);
}

async function resolveDepartmentId(metadata = {}) {
  if (typeof metadata.department_id === "string") {
    const department = await prisma.depts.findUnique({
      where: { dept_id: metadata.department_id },
      select: { dept_id: true, is_active: true },
    });
    if (department?.is_active) return department.dept_id;
  }

  if (typeof metadata.department === "string" && metadata.department.trim()) {
    const department = await prisma.depts.findFirst({
      where: { dept_name: { equals: metadata.department.trim(), mode: "insensitive" } },
      select: { dept_id: true, is_active: true },
    });
    if (department?.is_active) return department.dept_id;
  }

  if (process.env.DEFAULT_DEPARTMENT_ID) {
    const department = await prisma.depts.findUnique({
      where: { dept_id: process.env.DEFAULT_DEPARTMENT_ID },
      select: { dept_id: true, is_active: true },
    });
    if (department?.is_active) return department.dept_id;
  }

  const activeDepartments = await prisma.depts.findMany({
    where: { is_active: true },
    select: { dept_id: true },
    take: 2,
  });
  if (activeDepartments.length === 1) return activeDepartments[0].dept_id;

  throw new Error(activeDepartments.length === 0
    ? "No active departments exist for the invited user"
    : "This database has multiple active departments; set department metadata on the invitation or configure DEFAULT_DEPARTMENT_ID");
}

export async function syncClerkUser(clerkUser, { createIfMissing = false } = {}) {
  const clerkUserId = clerkUser.id;
  const email = getEmail(clerkUser);
  if (!clerkUserId || !email) throw new Error("Clerk user is missing an ID or email address");

  const fullName = getFullName(clerkUser);
  const existing = await prisma.users.findFirst({
    where: {
      OR: [
        { clerk_user_id: clerkUserId },
        { email: { equals: email, mode: "insensitive" } },
      ],
    },
  });

  if (existing) {
    if (existing.clerk_user_id && existing.clerk_user_id !== clerkUserId) {
      throw new Error("The email address is already linked to a different Clerk account");
    }
    return prisma.users.update({
      where: { user_id: existing.user_id },
      data: {
        clerk_user_id: clerkUserId,
        full_name: fullName,
        email,
        updated_at: new Date(),
      },
    });
  }

  if (!createIfMissing) return null;

  const metadata = clerkUser.public_metadata ?? {};
  const deptId = await resolveDepartmentId(metadata);
  const roles = new Set(["employee", "reviewer", "dept_admin"]);
  const role = roles.has(metadata.role) ? metadata.role : "employee";
  const employeeCode = typeof metadata.employee_code === "string" ? metadata.employee_code.trim().slice(0, 50) : "";
  return prisma.users.create({
    data: {
      clerk_user_id: clerkUserId,
      full_name: fullName,
      email,
      employee_code: employeeCode || null,
      dept_id: deptId,
      role,
      status: "pending",
    },
  });
}

export async function linkExistingUserByEmail(clerkUserId, email) {
  if (!email) return null;
  const appUser = await prisma.users.findFirst({
    where: { email: { equals: email.trim(), mode: "insensitive" } },
  });
  if (!appUser) return null;
  if (appUser.clerk_user_id && appUser.clerk_user_id !== clerkUserId) return null;

  return prisma.users.update({
    where: { user_id: appUser.user_id },
    data: { clerk_user_id: clerkUserId, updated_at: new Date() },
  });
}
