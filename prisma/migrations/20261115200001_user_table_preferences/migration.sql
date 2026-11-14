-- Each staff member's arrangement of an admin table (hidden columns, pinned first column), per table.
CREATE TABLE "UserTablePreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tableKey" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserTablePreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserTablePreference_userId_tableKey_key" ON "UserTablePreference"("userId", "tableKey");

ALTER TABLE "UserTablePreference" ADD CONSTRAINT "UserTablePreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
