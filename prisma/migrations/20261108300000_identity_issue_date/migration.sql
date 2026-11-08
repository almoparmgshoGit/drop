-- When an employee's identity document, and each filed document, was issued.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "idIssueDate" DATE;

-- AlterTable
ALTER TABLE "EmployeeDocument" ADD COLUMN     "issueDate" DATE;

