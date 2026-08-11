import type { NormalizeDatabaseStatementInput } from './internal/types.js'

const DEFAULT_DATABASE_STATEMENT_MAX_LENGTH = 2_000

export const normalizeDatabaseStatement = ({
    maxLength = DEFAULT_DATABASE_STATEMENT_MAX_LENGTH,
    statement,
}: NormalizeDatabaseStatementInput): string =>
    statement
        .replace(/'([^']|'')*'/gu, '?')
        .replace(/\$\d+/gu, '?')
        .replace(/\b\d+(\.\d+)?\b/gu, '?')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, maxLength)

export const getDatabaseOperation = (statement: string): string => statement.trim().split(/\s+/u)[0]?.toUpperCase() ?? 'QUERY'
