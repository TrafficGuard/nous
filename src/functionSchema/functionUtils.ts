/**
 * Parse a string into an array. Handles JSON array and line-separated formatting.
 * @param paramValue
 */
export function parseArrayParameterValue(paramValue: string): string[] {
	if (!paramValue) return [];
	if (typeof paramValue !== 'string') throw new Error(`paramValue should be string. Was ${typeof paramValue}`);
	paramValue = paramValue.trim();
	if (paramValue.startsWith('[')) {
		try {
			return JSON.parse(paramValue);
		} catch (e) {}
	}
	return paramValue
		.split('\n')
		.map((path) => path.trim())
		.filter((path) => path.length);
}
