/**
 * Test the analysis pipeline with sample data
 */
import { analyzeMenu } from '../lib/analysis.js';
import { formatRecommendations } from '../lib/formatter.js';

// Set API key from env
if (!process.env.ANTHROPIC_API_KEY) {
  // Read from .env file
  const { readFileSync } = await import('node:fs');
  const envContent = readFileSync(new URL('../../../.env', import.meta.url), 'utf8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.+)$/);
    if (match) process.env[match[1]] = match[2];
  }
}

// Sample menu items (subset from actual scrape)
const sampleItems = [
  { day: 'Monday', name: 'Tacos', restaurant: 'Chubby Tacos', price: 0, description: 'Corn tortillas with choice of protein' },
  { day: 'Monday', name: 'Burritos', restaurant: 'Chubby Tacos', price: 5, description: 'Rice, Beans, Cheese, Lettuce' },
  { day: 'Monday', name: 'Chubby Bowl', restaurant: 'Chubby Tacos', price: 5, description: 'Rice, Beans, Cheese' },
  { day: 'Monday', name: 'Chubby Salad', restaurant: 'Chubby Tacos', price: 5, description: 'Lettuce, Beans, Cheese' },
  { day: 'Monday', name: 'Torta', restaurant: 'Chubby Tacos', price: 9.99, description: 'Guacamole, lettuce, pico, cheese, sour cream, refried beans on mexican bread' },
  { day: 'Tuesday', name: 'BBQ Luau Bowl', restaurant: 'Mahana Fresh', price: 11.99, description: 'Basmati Rice, Roasted Sweet Potatoes, Garlicky Cilantro Green Beans, BBQ Chicken' },
  { day: 'Tuesday', name: 'Island Bliss Bowl', restaurant: 'Mahana Fresh', price: 11.99, description: 'Kale Crunch, Buffalo Cauliflower, Honey Sriracha Brussels Sprouts, Key West Chicken' },
  { day: 'Tuesday', name: 'Spicy Ahi Aloha Bowl', restaurant: 'Mahana Fresh', price: 15.99, description: 'Sweet Potato Noodles, Honey Sriracha Brussels Sprouts, Sesame Ginger Broccoli, Spicy Ahi Tuna' },
  { day: 'Wednesday', name: 'Saag Paneer', restaurant: 'Anjappar Indian', price: 16.99, description: 'Cottage cheese in spinach gravy' },
  { day: 'Wednesday', name: 'Paneer Tikka', restaurant: 'Anjappar Indian', price: 16.99, description: 'Marinated paneer grilled in tandoor oven with onions and bell peppers' },
  { day: 'Thursday', name: 'Flautas De Pollo', restaurant: 'La Victoria', price: 10.99, description: 'Crispy corn tortilla, shredded chicken, lettuce, pico de gallo chipotle cream, cheese dip' },
  { day: 'Thursday', name: 'Veggie Bowl', restaurant: 'La Victoria', price: 11.99, description: 'Black beans, lettuce, rice, fresh corn, pico de gallo, cheese' },
  { day: 'Friday', name: 'Saag Paneer', restaurant: "Mirchi's Indian Kitchen", price: 16, description: 'Cottage cheese cooked in slow-simmered spinach gravy' },
  { day: 'Friday', name: 'Butter Chicken', restaurant: "Mirchi's Indian Kitchen", price: 18, description: 'Tandoori chicken simmered in tomato-butter sauce' },
];

console.log('Running 3-agent analysis on sample menu...\n');
const recs = await analyzeMenu(sampleItems, 20);

console.log(`\nGot ${recs.length} recommendations:\n`);
for (const rec of recs) {
  console.log(`${rec.day}: ${rec.item_name} (${rec.restaurant}) - $${rec.price}`);
  console.log(`  Nutrition: ${rec.nutrition_score}, Longevity: ${rec.longevity_score}, Overall: ${rec.overall_score}`);
  console.log(`  ${rec.reasoning}`);
  console.log(`  Runner-up: ${rec.runner_up}\n`);
}

console.log('\n--- Formatted Telegram Message ---\n');
const messages = formatRecommendations(recs, '2026-04-06');
for (const msg of messages) {
  console.log(msg);
  console.log('\n---\n');
}
