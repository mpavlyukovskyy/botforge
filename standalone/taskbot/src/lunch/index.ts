/**
 * Lunch module -- re-exports all lunch submodules for cleaner imports.
 */
export { ensureLunchDb, getLunchDb, getCurrentWeekOf, getMenuForWeek, getRecommendationsForWeek, storeMenuItems, storeRecommendations, dbMenuToAnalysisFormat, logScrape } from './db.js';
export type { MenuItem, MenuRow, RecommendationRow } from './db.js';
export { scrapeMenu } from './scraper.js';
export { analyzeMenu } from './analysis.js';
export type { Recommendation } from './analysis.js';
export { formatRecommendations, formatMenu } from './formatter.js';
