#!/usr/bin/env node
/**
 * Wipes ALL products + categories for a business, then re-seeds:
 *   8 parent categories × 4 subs × 4 leaves × 16 products = 2,048 products
 *
 * Usage:
 *   node backend/scripts/cleanup-and-reseed-ecom.js [slug] [country]
 *
 * Examples:
 *   node backend/scripts/cleanup-and-reseed-ecom.js ecom IN
 */

'use strict';

const { PrismaClient } = require('@prisma/client');
const path = require('path');

const prisma = new PrismaClient();
const TARGET_SLUG = process.argv[2] || 'ecom';
const COUNTRY = (process.argv[3] || 'IN').toUpperCase();

const { seedBrandsForBusiness } = require(path.join(__dirname, '..', 'src', 'core', 'lib', 'brandCatalog'));

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// ─── Category tree (8 parents × 4 subs × 4 leaves = 128 leaves) ──────────────

const CATEGORY_TREE = [
  { name: 'Fresh Produce', emoji: '🥬', priceRange: [2000, 30000], brandHint: 'unbranded',
    children: [
      { name: 'Fruits', children: ['Apples & Pears', 'Tropical Fruits', 'Berries', 'Citrus'] },
      { name: 'Vegetables', children: ['Leafy Greens', 'Root Vegetables', 'Tomatoes & Peppers', 'Onions & Garlic'] },
      { name: 'Herbs & Sprouts', children: ['Fresh Herbs', 'Microgreens', 'Sprouts', 'Edible Flowers'] },
      { name: 'Organic Range', children: ['Organic Fruits', 'Organic Vegetables', 'Organic Herbs', 'Organic Salads'] },
    ]},
  { name: 'Dairy, Bakery & Eggs', emoji: '🥛', priceRange: [3000, 40000], brandHint: 'dairy',
    children: [
      { name: 'Milk & Cream', children: ['Cow Milk', 'Buffalo Milk', 'Plant Milk', 'Cream & Butter'] },
      { name: 'Cheese & Curd', children: ['Hard Cheese', 'Soft Cheese', 'Paneer', 'Yogurt & Curd'] },
      { name: 'Eggs', children: ['Hen Eggs', 'Duck Eggs', 'Quail Eggs', 'Liquid Eggs'] },
      { name: 'Bakery', children: ['Bread & Buns', 'Cakes & Pastries', 'Cookies', 'Indian Sweets'] },
    ]},
  { name: 'Meat & Seafood', emoji: '🥩', priceRange: [10000, 80000], brandHint: 'meat',
    children: [
      { name: 'Chicken', children: ['Whole Chicken', 'Boneless', 'Drumsticks', 'Wings'] },
      { name: 'Mutton & Lamb', children: ['Mutton Curry Cut', 'Mutton Chops', 'Mutton Mince', 'Lamb Special'] },
      { name: 'Seafood', children: ['Prawns', 'Fish Fillet', 'Whole Fish', 'Crab & Squid'] },
      { name: 'Plant-Based', children: ['Soya Chunks', 'Mock Meat', 'Tofu', 'Tempeh'] },
    ]},
  { name: 'Beverages', emoji: '🧃', priceRange: [2000, 30000], brandHint: 'beverage',
    children: [
      { name: 'Soft Drinks', children: ['Cola', 'Lemon-Lime', 'Orange Soda', 'Energy Drinks'] },
      { name: 'Juices', children: ['Fruit Juice', 'Vegetable Juice', 'Coconut Water', 'Smoothies'] },
      { name: 'Tea & Coffee', children: ['Black Tea', 'Green Tea', 'Instant Coffee', 'Filter Coffee'] },
      { name: 'Water', children: ['Mineral Water', 'Sparkling Water', 'Flavored Water', 'Bulk Cans'] },
    ]},
  { name: 'Snacks & Confectionery', emoji: '🍪', priceRange: [1000, 30000], brandHint: 'snack',
    children: [
      { name: 'Chips & Crisps', children: ['Potato Chips', 'Corn Chips', 'Banana Chips', 'Veggie Chips'] },
      { name: 'Biscuits & Cookies', children: ['Cream Biscuits', 'Glucose Biscuits', 'Wafer Biscuits', 'Oat Cookies'] },
      { name: 'Chocolates', children: ['Milk Chocolate', 'Dark Chocolate', 'White Chocolate', 'Filled Bars'] },
      { name: 'Nuts & Seeds', children: ['Almonds', 'Cashews', 'Mixed Nuts', 'Seeds Mix'] },
    ]},
  { name: 'Pantry & Cooking', emoji: '🫙', priceRange: [3000, 80000], brandHint: 'pantry',
    children: [
      { name: 'Rice & Grains', children: ['Basmati Rice', 'Brown Rice', 'Quinoa', 'Millets'] },
      { name: 'Flour & Pulses', children: ['Wheat Atta', 'Multigrain Atta', 'Toor Dal', 'Moong Dal'] },
      { name: 'Oils & Ghee', children: ['Sunflower Oil', 'Mustard Oil', 'Olive Oil', 'Pure Ghee'] },
      { name: 'Spices & Masalas', children: ['Whole Spices', 'Ground Spices', 'Masala Mixes', 'Pickles'] },
    ]},
  { name: 'Frozen & Ready Meals', emoji: '🧊', priceRange: [8000, 50000], brandHint: 'frozen',
    children: [
      { name: 'Frozen Vegetables', children: ['Peas & Corn', 'Mixed Veg', 'French Fries', 'Veg Patty'] },
      { name: 'Frozen Snacks', children: ['Spring Rolls', 'Samosas', 'Cutlets', 'Tikka Bites'] },
      { name: 'Ice Cream', children: ['Tubs', 'Cones', 'Sticks', 'Sundae Cups'] },
      { name: 'Ready Meals', children: ['Indian Curries', 'Pasta Meals', 'Pizza', 'Wraps'] },
    ]},
  { name: 'Personal Care', emoji: '🧴', priceRange: [5000, 60000], brandHint: 'personal',
    children: [
      { name: 'Hair Care', children: ['Shampoo', 'Conditioner', 'Hair Oil', 'Hair Color'] },
      { name: 'Skin Care', children: ['Face Wash', 'Moisturizer', 'Sunscreen', 'Body Lotion'] },
      { name: 'Oral Care', children: ['Toothpaste', 'Toothbrush', 'Mouthwash', 'Dental Floss'] },
      { name: 'Bath & Body', children: ['Soap Bars', 'Shower Gel', 'Talcum Powder', 'Deodorant'] },
    ]},
];

const VARIANTS = {
  'Apples & Pears': ['Royal Gala Apple','Granny Smith','Fuji Apple','Red Delicious','Honeycrisp','Bartlett Pear','Asian Pear','Bosc Pear','Pink Lady','Golden Delicious','Braeburn','Jazz Apple','Conference Pear','Williams Pear','Packham Pear','D\'Anjou Pear'],
  'Tropical Fruits': ['Alphonso Mango','Cavendish Banana','Queen Pineapple','Papaya','Dragon Fruit','Coconut','Lychee','Rambutan','Jackfruit','Starfruit','Guava','Passion Fruit','Longan','Mangosteen','Durian','Kiwi'],
  'Berries': ['Strawberry','Blueberry','Raspberry','Blackberry','Cranberry','Gooseberry','Mulberry','Boysenberry','Açaí Berry','Goji Berry','Elderberry','Huckleberry','Loganberry','Marionberry','Tayberry','Cloudberry'],
  'Citrus': ['Navel Orange','Mosambi','Eureka Lemon','Persian Lime','Ruby Grapefruit','Mandarin','Clementine','Blood Orange','Meyer Lemon','Cara Cara','Pomelo','Yuzu','Tangelo','Kumquat','Bergamot','Ugli Fruit'],
  'Leafy Greens': ['Baby Spinach','Methi','Curly Kale','Iceberg Lettuce','Fresh Coriander','Spearmint','Mustard Greens','Rocket','Chard','Collard Greens','Bok Choy','Watercress','Radicchio','Endive','Romaine','Cabbage'],
  'Root Vegetables': ['Desiree Potato','Sweet Potato','Dutch Carrot','Beetroot','Daikon Radish','White Turnip','Japanese Yam','Parsnip','Celeriac','Jerusalem Artichoke','Kohlrabi','Rutabaga','Taro','Cassava','Jicama','Sunchoke'],
  'Tomatoes & Peppers': ['Hybrid Tomato','Cherry Tomato','Red Capsicum','Yellow Bell Pepper','Jalapeño','Long Green Chilli','Pimiento','Habanero','Poblano','Shishito','Hungarian Wax','Bird Eye Chilli','Serrano','Ancho','Banana Pepper','Padron'],
  'Onions & Garlic': ['Red Onion','White Onion','Spring Onion','Garlic Bulb','Shallot','Ginger Root','Leek','Chive','Elephant Garlic','Black Garlic','Ramps','Pearl Onion','Scallion','Cipollini','Vidalia Onion','Walla Walla'],
  'Fresh Herbs': ['Flat-Leaf Parsley','Sweet Basil','Dill Weed','Garden Thyme','Rosemary','Sage','Tarragon','Chervil','Lovage','Lemon Balm','Oregano','Marjoram','Savory','Fennel Fronds','Bay Leaves','Curry Leaves'],
  'Microgreens': ['Pea Shoots','Radish Microgreens','Sunflower Shoots','Broccoli Microgreens','Mustard Micro','Amaranth','Beet Microgreens','Corn Shoots','Kale Microgreens','Arugula Micro','Basil Micro','Wheatgrass','Fenugreek Micro','Cabbage Micro','Chia Sprouts','Mung Micro'],
  'Sprouts': ['Moong Sprouts','Chickpea Sprouts','Alfalfa Sprouts','Wheatgrass','Lentil Sprouts','Radish Sprouts','Fenugreek Sprouts','Sunflower Sprouts','Broccoli Sprouts','Quinoa Sprouts','Adzuki Sprouts','Clover Sprouts','Mung Sprouts','Soy Sprouts','Pea Sprouts','Brussels Sprouts'],
  'Edible Flowers': ['Marigold Petals','Nasturtium','Pansy','Rose Petal','Calendula','Viola','Borage','Lavender','Hibiscus','Chamomile','Cornflower','Elderflower','Squash Blossom','Bee Balm','Anise Hyssop','Dandelion'],
  'Organic Fruits': ['Organic Fuji Apple','Organic Banana','Organic Alphonso Mango','Organic Blueberry','Organic Strawberry','Organic Pear','Organic Orange','Organic Grape','Organic Avocado','Organic Kiwi','Organic Lemon','Organic Peach','Organic Plum','Organic Cherry','Organic Lime','Organic Raspberry'],
  'Organic Vegetables': ['Organic Tomato','Organic Spinach','Organic Carrot','Organic Beetroot','Organic Broccoli','Organic Cauliflower','Organic Cucumber','Organic Zucchini','Organic Capsicum','Organic Kale','Organic Celery','Organic Pumpkin','Organic Sweet Potato','Organic Pea','Organic Leek','Organic Onion'],
  'Organic Herbs': ['Organic Basil','Organic Coriander','Organic Mint','Organic Parsley','Organic Dill','Organic Thyme','Organic Rosemary','Organic Chive','Organic Sage','Organic Tarragon','Organic Lemongrass','Organic Fennel','Organic Marjoram','Organic Oregano','Organic Lovage','Organic Chervil'],
  'Organic Salads': ['Organic Baby Spinach','Organic Rocket Mix','Organic Spring Mix','Organic Butter Lettuce','Organic Mesclun','Organic Watercress','Organic Mâche','Organic Frisée','Organic Radicchio Mix','Organic Endive Mix','Organic Asian Greens','Organic Rainbow Chard','Organic Beet Greens','Organic Kale Mix','Organic Pea Shoot Mix','Organic Herb Salad'],
  'Cow Milk': ['Full Cream Milk','Toned Milk','Double Toned Milk','Skim Milk','A2 Milk','Standardised Milk','Homogenised Milk','Jersey Cow Milk','Organic Cow Milk','Raw Milk','Pasteurised Milk','UHT Milk','Flavoured Milk','Lactose-Free Milk','Fortified Milk','Barista Milk'],
  'Buffalo Milk': ['Premium Buffalo Milk','Standardized Buffalo','Full Cream Buffalo','Pure Buffalo Milk','A2 Buffalo Milk','Organic Buffalo','Farm Fresh Buffalo','Pasteurised Buffalo','UHT Buffalo Milk','Homogenised Buffalo','Double Toned Buffalo','Skimmed Buffalo','Fortified Buffalo','Flavoured Buffalo','Raw Buffalo Milk','Buffalo Colostrum'],
  'Plant Milk': ['Almond Milk','Oat Milk','Soy Milk','Coconut Milk','Cashew Milk','Macadamia Milk','Rice Milk','Hemp Milk','Pea Milk','Hazelnut Milk','Quinoa Milk','Banana Milk','Flax Milk','Pistachio Milk','Sesame Milk','Walnut Milk'],
  'Cream & Butter': ['Salted Butter','Unsalted Butter','Cooking Cream','Whipping Cream','Sour Cream','Double Cream','Single Cream','Clotted Cream','Crème Fraîche','Cultured Butter','Ghee-Butter Blend','Spreadable Butter','Flavoured Butter','Compound Butter','Vegan Butter','Table Cream'],
  'Hard Cheese': ['Cheddar','Parmesan','Gouda','Edam','Pepper Jack','Gruyère','Manchego','Pecorino','Asiago','Emmental','Comté','Jarlsberg','Colby','Tilsit','Mimolette','Beaufort'],
  'Soft Cheese': ['Mozzarella','Cottage Cheese','Feta','Brie','Cream Cheese','Ricotta','Camembert','Chèvre','Burrata','Mascarpone','Labneh','Quark','Fromage Blanc','Neufchâtel','Brillat-Savarin','Taleggio'],
  'Paneer': ['Fresh Paneer','Smoked Paneer','Low-Fat Paneer','Paneer Tikka','Malai Paneer','Organic Paneer','A2 Paneer','Herb Paneer','Spiced Paneer','Grilled Paneer','Frozen Paneer','Block Paneer','Grated Paneer','Mini Paneer','Marinated Paneer','Tandoori Paneer'],
  'Yogurt & Curd': ['Plain Curd','Greek Yogurt','Fruit Yogurt','Lassi','Buttermilk','Dahi','Mishti Doi','Coconut Yogurt','Low-Fat Yogurt','Probiotic Yogurt','Skyr','Labneh','Drinking Yogurt','Frozen Yogurt','Flavored Kefir','Oat Yogurt'],
  'Hen Eggs': ['Brown Eggs','White Eggs','Free Range Eggs','Omega-3 Eggs','Cage-Free Eggs','Organic Eggs','Pastured Eggs','Jumbo Eggs','Large Eggs','Medium Eggs','Small Eggs','Double Yolk','Infertile Eggs','Fortified Eggs','Vitamin D Eggs','Heritage Breed Eggs'],
  'Duck Eggs': ['Free-Range Duck Eggs','Premium Duck Eggs','Organic Duck Eggs','Salted Duck Eggs','Preserved Duck Eggs','Smoked Duck Eggs','Spiced Duck Eggs','Farm Duck Eggs','White Duck Eggs','Large Duck Eggs','Mini Duck Eggs','Marinated Duck Eggs','Pickled Duck Eggs','Balut','Fertilised Duck Eggs','Infertile Duck Eggs'],
  'Quail Eggs': ['Fresh Quail Eggs','Pickled Quail Eggs','Smoked Quail Eggs','Organic Quail Eggs','Marinated Quail Eggs','Salted Quail Eggs','Boiled Quail Eggs','Spiced Quail Eggs','Farm Quail Eggs','Mini Quail Eggs','Free-Range Quail','Preserved Quail','Heritage Quail Eggs','Coloured Quail Eggs','Infertile Quail','Coturnix Eggs'],
  'Liquid Eggs': ['Whole Egg Liquid','Egg Whites','Yolk Pack','Pasteurised Liquid Egg','Organic Liquid Egg','Fortified Egg Liquid','Flavoured Egg White','Low-Cholesterol Liquid','Free-Range Liquid Egg','Cage-Free Liquid','Omega-3 Liquid Egg','Scrambled Egg Mix','Omelette Mix','Egg White Protein','Whole Egg Powder','Meringue Mix'],
  'Bread & Buns': ['White Sandwich Bread','Whole Wheat Bread','Multigrain Loaf','Sourdough Loaf','Brioche Buns','Burger Buns','Dinner Rolls','Ciabatta','Focaccia','Rye Bread','Pita Bread','Naan','Baguette','Pretzel Bun','Challah','Pumpernickel'],
  'Cakes & Pastries': ['Chocolate Fudge Cake','Vanilla Sponge','Black Forest Gâteau','Croissant','Pain au Chocolat','Danish Pastry','Éclair','Mille-Feuille','Opera Cake','Red Velvet','Carrot Cake','Lemon Drizzle','Fruit Tart','Apple Strudel','Tiramisu Slice','Cannoli'],
  'Cookies': ['Choco Chip Cookies','Classic Butter Cookie','Oatmeal Raisin','Almond Biscotti','Snickerdoodle','Peanut Butter Cookie','Shortbread','Macaroon','Ginger Snap','Sugar Cookie','Lemon Cookie','Double Chocolate','Walnut Cookie','Thumbprint Cookie','Linzer Cookie','Rugelach'],
  'Indian Sweets': ['Gulab Jamun','Kaju Katli','Rasgulla','Soan Papdi','Mysore Pak','Besan Ladoo','Motichoor Ladoo','Barfi','Halwa','Jalebi','Imarti','Peda','Kheer Mix','Gajar Ka Halwa','Rasmalai','Cham Cham'],
  'Whole Chicken': ['Whole Broiler Chicken','Free-Range Whole Chicken','Country Chicken','Desi Murga','Corn-Fed Chicken','Organic Whole Chicken','Marinated Whole Chicken','Spatchcock Chicken','Kosher Chicken','Halal Whole Chicken','Fresh Village Chicken','Rock Cornish Hen','Poulet Noir','Label Rouge','Silkie Chicken','Heritage Whole Chicken'],
  'Boneless': ['Chicken Breast Fillet','Chicken Thigh Fillet','Chicken Mince','Chicken Tenderloin','Boneless Leg','Chicken Strips','Chicken Cube','Marinated Breast','Stuffed Chicken Breast','Chicken Schnitzel','Chicken Escalope','Chicken Piccata','Chicken Saltimbocca','Chicken Kiev','Chicken Roulade','Chicken Milanese'],
  'Drumsticks': ['Chicken Drumsticks','Skinless Drumsticks','Marinated Drumsticks','Honey-Glazed Drums','BBQ Drumsticks','Spiced Drumsticks','Herb Drumsticks','Lemon-Pepper Drums','Teriyaki Drumsticks','Buffalo Drumsticks','Cajun Drumsticks','Jerk Drumsticks','Tandoori Drumsticks','Garlic Drumsticks','Smoky Drumsticks','Korean Drumsticks'],
  'Wings': ['Chicken Wings','Buffalo Wings','Hot Wings','Honey-Garlic Wings','BBQ Wings','Crispy Wings','Teriyaki Wings','Lemon-Pepper Wings','Parmesan Wings','Korean Wings','Jerk Wings','Cajun Wings','Ranch Wings','Sweet Chilli Wings','Tandoori Wings','Mango-Habanero Wings'],
  'Mutton Curry Cut': ['Mutton Curry Cut','Mutton Bone-In','Mutton Boneless','Goat Curry Cut','Mutton Ribs','Mutton Neck','Mutton Shoulder','Mutton Leg Curry','Mutton Raan','Mutton Rack','Mutton Shank','Mutton Breast','Mutton Flank','Mutton Kidney','Mutton Liver','Mutton Heart'],
  'Mutton Chops': ['Mutton Chops','Lamb Chops','French-Cut Chops','T-Bone Chops','Rib Chops','Loin Chops','Shoulder Chops','Double Chops','Marinated Chops','Herb Chops','Garlic Chops','Spiced Chops','BBQ Chops','Tandoori Chops','Grilled Chops','Rosemary Chops'],
  'Mutton Mince': ['Mutton Keema','Premium Mutton Mince','Fine Mutton Mince','Goat Mince','Lamb Kofta Mix','Seekh Kebab Mix','Mutton Burger Patty','Spiced Mince','Herb Mince','Lean Mutton Mince','Mutton Bolognese','Mutton Sausage Mix','Mutton Meatball Mix','Merguez Mix','Kofta Blend','Kofte Mix'],
  'Lamb Special': ['Lamb Leg Roast','Lamb Shoulder','Lamb Rack','Lamb Saddle','Lamb Crown','Lamb Rump','Lamb Cutlets','Lamb Loin','Lamb Shank','Lamb Breast','Lamb Neck','Lamb Liver','Lamb Kidney','Lamb Sweetbreads','Lamb Tongue','Lamb Bone Broth'],
  'Prawns': ['Tiger Prawns','Jumbo Prawns','Peeled Prawns','Wild Prawns','King Prawns','Banana Prawns','Vannamei Prawns','Spot Prawns','Langoustines','Dublin Bay Prawns','Scampi','Marinated Prawns','Garlic Prawns','Chilli Prawns','Battered Prawns','Coconut Prawns'],
  'Fish Fillet': ['Salmon Fillet','Tuna Steak','Basa Fillet','Pomfret Fillet','Barramundi Fillet','Snapper Fillet','Cod Fillet','Haddock Fillet','Tilapia Fillet','Trout Fillet','Mahi-Mahi Fillet','Swordfish Steak','Halibut Fillet','Sole Fillet','Grouper Fillet','Sea Bass Fillet'],
  'Whole Fish': ['Whole Pomfret','Whole Rohu','Whole Mackerel','Whole Sardine','Whole Snapper','Whole Sea Bass','Whole Trout','Whole Bream','Whole Mullet','Whole Tilapia','Whole Catfish','Whole Carp','Whole Herring','Whole Anchovy','Whole John Dory','Whole Kingfish'],
  'Crab & Squid': ['Mud Crab','Soft Shell Crab','Squid Rings','Calamari Tubes','Blue Swimmer Crab','Dungeness Crab','Snow Crab Legs','King Crab Legs','Crab Meat','Octopus','Baby Octopus','Cuttlefish','Squid Ink','Whole Squid','Stuffed Squid','Tempura Squid'],
  'Soya Chunks': ['Soya Chunks Large','Soya Granules','Soya Mince','Textured Soy Protein','Soya Slices','Mini Soya Chunks','Flavoured Soya','Marinated Soya','BBQ Soya Chunks','Spiced Soya','Herb Soya Chunks','Curry Soya','Tandoori Soya','Smoked Soya','Organic Soya Chunks','Non-GMO Soya'],
  'Mock Meat': ['Plant Chicken','Plant Mutton','Plant Mince','Plant Burger Patty','Plant Sausage','Plant Bacon','Plant Steak','Plant Duck','Plant Prawn','Plant Crab','Plant Tuna','Plant Salmon','Plant Turkey','Plant Ham','Plant Salami','Plant Chorizo'],
  'Tofu': ['Firm Tofu','Silken Tofu','Smoked Tofu','Marinated Tofu','Baked Tofu','Fried Tofu','Crispy Tofu','Seasoned Tofu','Herb Tofu','Spiced Tofu','Organic Tofu','Non-GMO Tofu','Soft Tofu','Extra-Firm Tofu','Grilled Tofu','Scrambled Tofu'],
  'Tempeh': ['Plain Tempeh','Smoky Tempeh','Herb Tempeh','Marinated Tempeh','BBQ Tempeh','Spiced Tempeh','Grain Tempeh','Organic Tempeh','Three-Grain Tempeh','Black Bean Tempeh','Coconut Tempeh','Teriyaki Tempeh','Curry Tempeh','Garlic Tempeh','Seaweed Tempeh','Flax Tempeh'],
  'Cola': ['Classic Cola','Diet Cola','Zero Sugar Cola','Cherry Cola','Vanilla Cola','Lemon Cola','Lime Cola','Orange Cola','Raspberry Cola','Ginger Cola','Coconut Cola','Caramel Cola','Spiced Cola','Craft Cola','Heritage Cola','Mexican Cola'],
  'Lemon-Lime': ['Classic Lemon Soda','Lime Soda','Lime Cordial','Citrus Twist','Sparkling Lemonade','Still Lemonade','Pink Lemonade','Elderflower Lemonade','Ginger Lemonade','Mint Lemonade','Raspberry Lemonade','Lavender Lemonade','Cucumber Lime','Lemon Squash','Lime Squash','Yuzu Lemonade'],
  'Orange Soda': ['Classic Orange','Sparkling Orange','Orange Squash','Blood Orange','Mandarin Soda','Tangerine Fizz','Orange Crush','Orange Zero','Diet Orange','Orange & Mango','Orange & Passionfruit','Orange & Guava','Orange Cordial','Orange Blossom','Bitter Orange','Cara Cara Soda'],
  'Energy Drinks': ['Original Energy','Sugar-Free Energy','Berry Energy','Tropical Energy','Citrus Energy','Watermelon Energy','Grape Energy','Peach Energy','Mango Energy','Apple Energy','Coconut Energy','Green Tea Energy','Matcha Energy','Ginger Energy','Cherry Energy','Pomegranate Energy'],
  'Fruit Juice': ['Apple Juice','Orange Juice','Mango Juice','Mixed Fruit Juice','Guava Juice','Pineapple Juice','Grape Juice','Pomegranate Juice','Cranberry Juice','Watermelon Juice','Lychee Juice','Passion Fruit Juice','Peach Juice','Cherry Juice','Pear Juice','Apricot Juice'],
  'Vegetable Juice': ['Beetroot Juice','Wheatgrass Juice','Celery Juice','Carrot Juice','Tomato Juice','Spinach Juice','Kale Juice','Cucumber Juice','Ginger Juice','Turmeric Juice','Green Detox','Red Vitality','Purple Power','Orange Glow','Green Machine','Morning Shot'],
  'Coconut Water': ['Tender Coconut Water','Plain Coconut Water','Lemon Coconut Water','Mango Coconut Water','Pineapple Coconut','Watermelon Coconut','Strawberry Coconut','Peach Coconut','Coconut Water Kefir','Sparkling Coconut','Organic Coconut Water','Raw Coconut Water','Pink Coconut Water','Coconut Water Blend','Chilled Coconut','Aged Coconut Water'],
  'Smoothies': ['Banana Smoothie','Berry Smoothie','Mango Smoothie','Green Smoothie','Tropical Smoothie','Avocado Smoothie','Peach Smoothie','Strawberry Smoothie','Mixed Berry','Açaí Smoothie','Pitaya Smoothie','Kale Smoothie','Spinach Smoothie','Beet Smoothie','Protein Smoothie','Detox Smoothie'],
  'Black Tea': ['Premium Assam','Earl Grey','English Breakfast','Masala Chai','Darjeeling First Flush','Ceylon Orange Pekoe','Irish Breakfast','Keemun','Yunnan Golden','Lapsang Souchong','Lady Grey','Russian Caravan','Nilgiri Tea','Dimbula Tea','Kenyan Tea','Rwandan Tea'],
  'Green Tea': ['Pure Sencha','Lemon Green Tea','Mint Green Tea','Matcha Powder','Gyokuro','Genmaicha','Hojicha','Dragon Well','Bi Luo Chun','Jasmine Green Tea','Moroccan Mint','Green Tea Tulsi','Chamomile Green','Honey Green Tea','Berry Green Tea','Peach Green Tea'],
  'Instant Coffee': ['Classic Instant','Premium Roast','Decaf Instant','Mocha Mix','Cappuccino Mix','Latte Mix','Espresso Powder','French Vanilla','Hazelnut Instant','Caramel Instant','Colombian Instant','Brazilian Blend','Ethiopian Instant','Chicory Blend','White Coffee Mix','Iced Coffee Mix'],
  'Filter Coffee': ['South Indian Filter','French Roast','Italian Roast','Espresso Ground','Vienna Roast','Ethiopian Blend','Colombian Whole Bean','Brazilian Santos','Monsoon Malabar','Coorg Robusta','Cold Brew Blend','Pour Over Blend','Aeropress Blend','Chemex Blend','Turkish Ground','Drip Coffee Blend'],
  'Mineral Water': ['Still Mineral Water','Spring Water','Alkaline Water','Artesian Water','Glacial Water','Mountain Water','Deep Sea Water','Ionized Water','Hydrogen Water','Electrolyte Water','Silica Water','Low-Sodium Mineral','High-Calcium Mineral','Magnesium-Rich Water','pH-Balanced Water','Zero TDS Water'],
  'Sparkling Water': ['Plain Sparkling','Lemon Sparkling','Lime Sparkling','Orange Sparkling','Berry Sparkling','Grapefruit Sparkling','Cucumber Sparkling','Elderflower Sparkling','Mint Sparkling','Apple Sparkling','Peach Sparkling','Watermelon Sparkling','Tropical Sparkling','Cherry Sparkling','Raspberry Sparkling','Pomegranate Sparkling'],
  'Flavored Water': ['Lemon Water','Cucumber Water','Berry Water','Peach Water','Mango Water','Rose Water Drink','Hibiscus Water','Mint Water','Coconut Flavor Water','Apple Water','Watermelon Water','Passionfruit Water','Ginger Water','Kiwi Water','Pear Water','Pomegranate Water'],
  'Bulk Cans': ['20L Water Can','10L Water Can','5L Water Bottle','Office Water Pack','12×500ml Pack','24×330ml Pack','Family Water Pack','Industrial Water Can','Catering Water Can','Event Water Pack','Trial Water Pack','Multi-Buy 6×1.5L','Economy Pack 12×1L','Bulk Still 6×2L','Bulk Sparkling 6×1.5L','Wholesale Water Can'],
  'Potato Chips': ['Salted','Cream & Onion','Masala','Cheese & Onion','Tomato','BBQ','Sour Cream & Chive','Salt & Vinegar','Jalapeno','Paprika','Sweet Chilli','Prawn Cocktail','Worcestershire','Pickle','Ketchup','Peri Peri'],
  'Corn Chips': ['Original Tortilla','Nacho Cheese','Sour Cream','Hot & Spicy','Ranch','Cool Ranch','Lime & Salt','Chilli Lime','Black Bean','Multigrain Tortilla','White Corn','Yellow Corn','Sweet Corn','BBQ Corn','Butter Corn','Caramel Corn'],
  'Banana Chips': ['Salted Banana Chips','Pepper Banana Chips','Sweet Banana Chips','Honey Banana Chips','Chilli Banana Chips','Masala Banana Chips','Plain Banana Chips','Jaggery Banana Chips','Turmeric Banana Chips','Curry Leaf Banana','Coconut Banana Chips','Cinnamon Banana','Chocolate Banana','Strawberry Banana','Mixed Fruit Chips','Mango Chips'],
  'Veggie Chips': ['Beetroot Chips','Sweet Potato Chips','Mixed Veg Chips','Kale Chips','Spinach Chips','Carrot Chips','Parsnip Chips','Zucchini Chips','Lotus Root Chips','Taro Chips','Edamame Chips','Green Bean Chips','Snap Pea Crisps','Lentil Chips','Chickpea Chips','Cassava Chips'],
  'Cream Biscuits': ['Bourbon','Strawberry Cream','Chocolate Cream','Orange Cream','Vanilla Cream','Lemon Cream','Coconut Cream','Mint Cream','Banana Cream','Blueberry Cream','Raspberry Cream','Caramel Cream','Cookies & Cream','Double Chocolate','Hazelnut Cream','Coffee Cream'],
  'Glucose Biscuits': ['Plain Glucose','Milk Glucose','Honey Glucose','Wheat Glucose','Calcium Plus','Iron Fortified','Vitamin D Glucose','Wholegrain Glucose','Low-Sugar Glucose','Oat Glucose','Ragi Glucose','Multigrain Glucose','Diabetic Glucose','Sports Glucose','Energy Glucose','Kids Glucose'],
  'Wafer Biscuits': ['Chocolate Wafer','Vanilla Wafer','Strawberry Wafer','Hazelnut Wafer','Caramel Wafer','Coffee Wafer','Coconut Wafer','Orange Wafer','Lemon Wafer','Mint Wafer','Peanut Butter Wafer','Cream Wafer Roll','Dark Chocolate Wafer','White Chocolate Wafer','Mocha Wafer','Tiramisu Wafer'],
  'Oat Cookies': ['Classic Oat','Oat & Raisin','Oat & Cranberry','Oat & Honey','Chocolate Oat','Peanut Butter Oat','Coconut Oat','Cinnamon Oat','Blueberry Oat','Banana Oat','Apple Oat','Ginger Oat','Almond Oat','Walnut Oat','Flaxseed Oat','Quinoa Oat'],
  'Milk Chocolate': ['Classic Milk Chocolate','Almond Milk Chocolate','Hazelnut Milk Chocolate','Caramel Milk Chocolate','Raisin Milk Chocolate','Crispy Milk Chocolate','Biscuit Milk Chocolate','Truffle Milk Chocolate','Mint Milk Chocolate','Orange Milk Chocolate','Strawberry Milk Chocolate','Coconut Milk Chocolate','Toffee Milk Chocolate','Honeycomb Milk Chocolate','Raspberry Milk Chocolate','Coffee Milk Chocolate'],
  'Dark Chocolate': ['70% Dark','85% Dark','Sea Salt Dark','Orange Dark','Chilli Dark','Mint Dark','Espresso Dark','Almond Dark','Hazelnut Dark','Raspberry Dark','Cherry Dark','Ginger Dark','Cardamom Dark','Rose Dark','Lavender Dark','Matcha Dark'],
  'White Chocolate': ['Classic White','Strawberry White','Cranberry White','Raspberry White','Lemon White','Passion Fruit White','Mango White','Coconut White','Pistachio White','Almond White','Macadamia White','Salted Caramel White','Matcha White','Blueberry White','Vanilla Bean White','Rose White'],
  'Filled Bars': ['Caramel Bar','Wafer Bar','Crispy Bar','Fruit & Nut Bar','Nougat Bar','Toffee Bar','Peanut Butter Bar','Coconut Bar','Hazelnut Bar','Almond Bar','Biscuit Bar','Praline Bar','Truffle Bar','Marzipan Bar','Marshmallow Bar','Crunch Bar'],
  'Almonds': ['Whole Raw Almonds','Salted Roasted Almonds','Smoked Almonds','Honey-Roasted Almonds','Blanched Almonds','Sliced Almonds','Slivered Almonds','Almond Flour','Almond Butter','Chocolate-Coated Almonds','Wasabi Almonds','Chilli Almonds','Tamari Almonds','Cinnamon Almonds','Vanilla Almonds','Coconut Almonds'],
  'Cashews': ['W320 Whole Cashews','Salted Cashews','Roasted Cashews','Honey Cashews','Chilli Cashews','Masala Cashews','Butter Cashews','Chocolate Cashews','Wasabi Cashews','Turmeric Cashews','BBQ Cashews','Coconut Cashews','Curry Cashews','Lemon Cashews','Sea Salt Cashews','Raw Cashew Pieces'],
  'Mixed Nuts': ['Premium Nut Mix','Energy Nut Mix','Trail Mix','Berry Nut Mix','Tropical Mix','Chocolate Nut Mix','Honey Roasted Mix','Spiced Mixed Nuts','Mediterranean Mix','Asian Nut Mix','Superfood Mix','Paleo Mix','Keto Nut Mix','Protein Nut Mix','Fitness Mix','Gourmet Nut Mix'],
  'Seeds Mix': ['Pumpkin Seeds','Sunflower Seeds','Chia Seeds','Flax Seeds','Hemp Seeds','Sesame Seeds','Poppy Seeds','Quinoa Seeds','Watermelon Seeds','Melon Seeds','Muskmelon Seeds','Fennel Seeds','Coriander Seeds','Cumin Seeds','Nigella Seeds','Mixed Seed Blend'],
  'Basmati Rice': ['Premium Long-Grain Basmati','Aged Basmati','Brown Basmati','Sella Basmati','1121 Basmati','Sugandha Basmati','Pusa Basmati','Sharbati Basmati','Kainat Basmati','Golden Sella','Steam Basmati','Organic Basmati','Parboiled Basmati','Mini Basmati','Traditional Basmati','Low-GI Basmati'],
  'Brown Rice': ['Brown Basmati','Brown Sona Masuri','Whole Grain Brown','Long Grain Brown','Short Grain Brown','Medium Grain Brown','Brown Jasmine','Wild & Brown Mix','Brown & Red Mix','Parboiled Brown','Sprouted Brown','Organic Brown','Low-GI Brown','Quick-Cook Brown','Brown Arborio','Brown Glutinous'],
  'Quinoa': ['White Quinoa','Red Quinoa','Black Quinoa','Tri-Color Quinoa','Puffed Quinoa','Quinoa Flakes','Quinoa Flour','Pre-Washed Quinoa','Organic Quinoa','Quick-Cook Quinoa','Royal Quinoa','Sprouted Quinoa','Toasted Quinoa','Quinoa Pasta Mix','Quinoa Porridge','Baby Quinoa'],
  'Millets': ['Foxtail Millet','Pearl Millet','Finger Millet','Little Millet','Barnyard Millet','Kodo Millet','Proso Millet','Teff','Sorghum','Job\'s Tears','Fonio','Acha Millet','Guinea Millet','Browntop Millet','Indian Millet Blend','Millet Flour'],
  'Wheat Atta': ['Whole Wheat Atta','Sharbati Atta','Stone-Ground Atta','MP Sharbati','Chakki Fresh Atta','Lok-1 Atta','Bansi Atta','Organic Whole Wheat','Fortified Atta','Malted Atta','High-Protein Atta','Diabetic Atta','Low-Gluten Atta','Sprouted Wheat Atta','Heritage Wheat Atta','Ancient Grain Atta'],
  'Multigrain Atta': ['7-Grain Atta','5-Grain Atta','Multigrain Plus','9-Grain Atta','Ancient Grain Mix','High-Fibre Multigrain','Protein Multigrain','Diabetic Multigrain','Low-GI Multigrain','Sprouted Multigrain','Quinoa Multigrain','Amaranth Multigrain','Millet Multigrain','Ragi Multigrain','Oat Multigrain','Chia Multigrain'],
  'Toor Dal': ['Premium Split Toor','Polished Toor Dal','Organic Toor Dal','Unpolished Toor','Masoor Toor Blend','Whole Pigeon Pea','Skinned Toor Dal','Washed Toor Dal','Quick-Cook Toor','Sundried Toor','Traditional Toor','Malwa Toor Dal','Karnataka Toor','Vidarbha Toor','Andhra Toor Dal','Low-GI Toor'],
  'Moong Dal': ['Yellow Split Moong','Whole Green Moong','Split Green Moong','Washed Moong Dal','Organic Moong Dal','Sprouted Moong','Urad Moong Blend','Chilka Moong','Quick-Cook Moong','Roasted Moong','Crispy Moong','Moong Flour','Baby Moong','Heritage Moong','Mung Bean Pasta','Low-GI Moong'],
  'Sunflower Oil': ['Refined Sunflower Oil','Cold-Pressed Sunflower','Premium Sunflower','Double-Refined Sunflower','High-Oleic Sunflower','Vitamin-E Sunflower','Blended Sunflower','Light Sunflower Oil','Organic Sunflower','Non-GMO Sunflower','Expeller-Pressed','Fortified Sunflower','Low-Absorb Sunflower','Chef\'s Sunflower','Professional Sunflower','Economy Sunflower'],
  'Mustard Oil': ['Kachi Ghani Mustard','Pungent Mustard Oil','Premium Mustard Oil','Double-Filtered Mustard','Cold-Pressed Mustard','Organic Mustard Oil','Pure Mustard Oil','Village-Pressed Mustard','Traditional Mustard Oil','Black Mustard Oil','Yellow Mustard Oil','Blended Mustard','Fortified Mustard','Low-Erucic Mustard','Certified Mustard','Heritage Mustard Oil'],
  'Olive Oil': ['Extra Virgin Olive Oil','Virgin Olive Oil','Pomace Olive Oil','Light Olive Oil','Pure Olive Oil','Cold-Pressed Extra Virgin','Infused Garlic Olive Oil','Herb-Infused Olive','Lemon Olive Oil','Chilli Olive Oil','Truffle Olive Oil','Basil Olive Oil','Rosemary Olive Oil','Organic Extra Virgin','Greek Extra Virgin','Italian Extra Virgin'],
  'Pure Ghee': ['Cow Ghee','Buffalo Ghee','Desi Ghee','Bilona Ghee','A2 Cow Ghee','Organic Cow Ghee','Turmeric Ghee','Herb Ghee','Garlic Ghee','Saffron Ghee','Rose Ghee','Cardamom Ghee','Cultured Butter Ghee','Clarified Butter','Brown Butter','Sheep Milk Ghee'],
  'Whole Spices': ['Black Pepper','Cumin Seeds','Green Cardamom','Whole Cloves','Cinnamon Sticks','Star Anise','Bay Leaves','Fennel Seeds','Mustard Seeds','Fenugreek Seeds','Carom Seeds','Mace Blades','Nutmeg','Turmeric Root','Dried Chilli','Saffron Strands'],
  'Ground Spices': ['Turmeric Powder','Red Chilli Powder','Coriander Powder','Garam Masala','Cumin Powder','Cardamom Powder','Black Pepper Powder','Ginger Powder','Garlic Powder','Onion Powder','Paprika Powder','Amchur Powder','Asafoetida','Chat Masala','Kashmiri Chilli','Smoked Paprika'],
  'Masala Mixes': ['Chicken Masala','Biryani Masala','Pav Bhaji Masala','Sambar Masala','Chole Masala','Rajma Masala','Dal Makhani Masala','Butter Chicken Masala','Tandoori Masala','Kebab Masala','Fish Masala','Mutton Masala','Paneer Masala','Kitchen King','Shahi Masala','Rogan Josh Masala'],
  'Pickles': ['Mango Pickle','Lime Pickle','Mixed Pickle','Garlic Pickle','Chilli Pickle','Lemon Pickle','Stuffed Chilli Pickle','Gongura Pickle','Avakaya','Tomato Pickle','Amla Pickle','Karawila Pickle','Raw Mango Pickle','Green Chilli Pickle','Prawn Pickle','Pork Pickle'],
  'Peas & Corn': ['Garden Peas','Sweet Corn','Mixed Peas & Corn','Sugar Snap Peas','Petite Peas','Baby Corn','Yellow Sweet Corn','White Sweet Corn','Snow Peas','Wasabi Peas','Corn on the Cob','Edamame','Pigeon Peas','Black-Eyed Peas','Chickpeas Frozen','Broad Beans Frozen'],
  'Mixed Veg': ['Garden Mix Veg','Stir-Fry Mix','Curry Mix','Asian Veg Mix','Mediterranean Mix','Roasting Mix','Soup Mix','Ratatouille Mix','Primavera Mix','Harvest Mix','Country Mix','Oriental Stir-Fry','Mexican Mix','Indian Veg Mix','Thai Veg Mix','Rainbow Veg Mix'],
  'French Fries': ['Crinkle-Cut Fries','Straight-Cut Fries','Potato Wedges','Smileys','Curly Fries','Shoestring Fries','Steak-Cut Fries','Sweet Potato Fries','Waffle Fries','Crispy Rings','Potato Waffles','Hash Browns','Potato Bites','Beer-Battered Fries','Seasoned Fries','Oven Chips'],
  'Veg Patty': ['Aloo Tikki','Veg Burger Patty','Spinach Patty','Corn Patty','Mixed Veg Patty','Beetroot Patty','Sweet Potato Patty','Quinoa Patty','Mushroom Patty','Black Bean Patty','Chickpea Patty','Lentil Patty','Edamame Patty','Jackfruit Patty','Cauliflower Patty','Oat Patty'],
  'Spring Rolls': ['Classic Veg Spring Roll','Chicken Spring Roll','Prawn Spring Roll','Mini Spring Rolls','Shanghai Spring Roll','Vietnamese Spring Roll','Thai Spring Roll','Crispy Spring Roll','Baked Spring Roll','Rice Paper Roll','Egg Roll','Lumpia','Popia','Harumaki','Chun Juan','Imperial Roll'],
  'Samosas': ['Aloo Samosa','Cocktail Samosa','Mini Samosa','Punjabi Samosa','Keema Samosa','Cheese Samosa','Corn Samosa','Onion Samosa','Samoosa','Baked Samosa','Air-Fry Samosa','Crispy Samosa','Party Samosa','Jumbo Samosa','Samosa Pinwheels','Samosa Chaat'],
  'Cutlets': ['Veg Cutlet','Chicken Cutlet','Fish Cutlet','Cheese Cutlet','Beetroot Cutlet','Mushroom Cutlet','Spinach Cutlet','Potato Cutlet','Mixed Cutlet','Lamb Cutlet','Prawn Cutlet','Tuna Cutlet','Oat Cutlet','Quinoa Cutlet','Lentil Cutlet','Paneer Cutlet'],
  'Tikka Bites': ['Paneer Tikka Bites','Chicken Tikka Bites','Veg Tikka Bites','Mushroom Tikka','Prawn Tikka','Lamb Tikka','Fish Tikka','Tofu Tikka','Cottage Cheese Tikka','Cauliflower Tikka','Corn Tikka','Soya Tikka','Jackfruit Tikka','Malai Tikka','Seekh Tikka','Haryali Tikka'],
  'Tubs': ['Vanilla Tub','Chocolate Tub','Mango Tub','Butterscotch Tub','Strawberry Tub','Cookies & Cream Tub','Mint Choc Chip Tub','Rocky Road Tub','Pistachio Tub','Caramel Swirl Tub','Black Currant Tub','Blueberry Cheesecake','Salted Caramel Tub','Dulce de Leche','Neapolitan Tub','Rainbow Sherbet Tub'],
  'Cones': ['Vanilla Cone','Chocolate Cone','Strawberry Cone','Mint Choc Chip Cone','Caramel Cone','Cookies & Cream Cone','Pistachio Cone','Mango Cone','Raspberry Ripple Cone','Toffee Cone','Bubblegum Cone','Cotton Candy Cone','Birthday Cake Cone','Rocky Road Cone','Salted Caramel Cone','Peanut Butter Cone'],
  'Sticks': ['Classic Choco Bar','Orange Ice Bar','Mango Kulfi Stick','Vanilla Stick','Strawberry Stick','Passion Fruit Stick','Coconut Stick','Lychee Stick','Watermelon Stick','Raspberry Stick','Espresso Bar','Caramel Stick','Almond Bar','Pistachio Stick','Rose Stick','Saffron Kulfi'],
  'Sundae Cups': ['Brownie Sundae','Caramel Sundae','Berry Sundae','Hot Fudge Sundae','Strawberry Sundae','Banana Split Cup','Butterscotch Sundae','Oreo Sundae','Peanut Butter Sundae','Pistachio Sundae','Mango Sundae','Mixed Berry Sundae','Toffee Sundae','Cheesecake Sundae','Red Velvet Sundae','S\'mores Sundae'],
  'Indian Curries': ['Paneer Butter Masala','Dal Makhani','Chicken Curry','Rajma','Chole','Dal Tadka','Palak Paneer','Mutton Rogan Josh','Matar Paneer','Chana Masala','Lamb Curry','Aloo Matar','Shahi Paneer','Kadai Chicken','Methi Matar Malai','Dum Aloo'],
  'Pasta Meals': ['Mac & Cheese','Pasta Alfredo','Pasta Arrabiata','Pesto Pasta','Pasta Bolognese','Carbonara','Lasagne','Mushroom Pasta','Tomato Basil Pasta','Aglio e Olio','Vodka Pasta','Rose Pasta','Cacio e Pepe','Pasta Primavera','Pasta Putanesca','Four Cheese Pasta'],
  'Pizza': ['Margherita Pizza','Pepperoni Pizza','BBQ Chicken Pizza','Veg Supreme Pizza','Hawaiian Pizza','Four Cheese Pizza','Mushroom Pizza','Pesto Chicken Pizza','Meat Feast Pizza','Tikka Masala Pizza','Truffle Pizza','Prawn Pizza','Spinach & Feta Pizza','Buffalo Chicken Pizza','Garlic Prawn Pizza','Caramelized Onion Pizza'],
  'Wraps': ['Veg Wrap','Chicken Wrap','Paneer Wrap','Fish Wrap','Falafel Wrap','Prawn Wrap','Lamb Wrap','Turkey Wrap','Tuna Wrap','Egg Wrap','BLT Wrap','Burrito','Quesadilla','Shawarma','Kathi Roll','Frankie'],
  'Shampoo': ['Anti-Dandruff Shampoo','Smooth & Silky Shampoo','Volume Shampoo','Colour Protect Shampoo','Moisturizing Shampoo','Repair Shampoo','Keratin Shampoo','Argan Oil Shampoo','Tea Tree Shampoo','Biotin Shampoo','Clarifying Shampoo','Sulphate-Free Shampoo','Baby Shampoo','Dry Shampoo','2-in-1 Shampoo','Purple Shampoo'],
  'Conditioner': ['Daily Care Conditioner','Repair Conditioner','Volume Conditioner','Colour Conditioner','Moisturizing Conditioner','Deep Conditioner','Leave-In Conditioner','Argan Oil Conditioner','Keratin Conditioner','Biotin Conditioner','Detangling Conditioner','Curl Conditioner','Sulphate-Free Conditioner','Baby Conditioner','Co-Wash','Hair Mask'],
  'Hair Oil': ['Coconut Hair Oil','Almond Hair Oil','Argan Hair Oil','Bhringraj Oil','Amla Hair Oil','Jojoba Oil','Castor Hair Oil','Olive Hair Oil','Onion Hair Oil','Rosemary Oil','Neem Hair Oil','Sesame Hair Oil','Mustard Hair Oil','Tea Tree Hair Oil','Vitamin E Hair Oil','Hair Serum Oil'],
  'Hair Color': ['Jet Black','Dark Brown','Medium Brown','Light Brown','Burgundy','Auburn','Dark Blonde','Light Blonde','Platinum Blonde','Red','Copper','Chestnut','Mahogany','Wine Red','Graphite','Silver'],
  'Face Wash': ['Foaming Face Wash','Charcoal Face Wash','Brightening Face Wash','Anti-Acne Face Wash','Moisturizing Face Wash','Exfoliating Face Wash','Gel Face Wash','Clay Face Wash','Micellar Face Wash','Salicylic Acid Wash','Niacinamide Wash','Vitamin C Face Wash','Rose Face Wash','Turmeric Face Wash','Aloe Face Wash','Sensitive Face Wash'],
  'Moisturizer': ['Daily Moisturizer','Night Cream','Light Moisturizer','SPF Moisturizer','Anti-Aging Cream','Hyaluronic Moisturizer','Vitamin C Moisturizer','Retinol Cream','Niacinamide Cream','Squalane Moisturizer','Ceramide Cream','Peptide Cream','Aloe Moisturizer','Rose Moisturizer','Oat Moisturizer','Barrier Cream'],
  'Sunscreen': ['SPF 30 Sunscreen','SPF 50 Sunscreen','SPF 50+ Sunscreen','Tinted SPF','Mineral Sunscreen','Chemical Sunscreen','Water-Resistant SPF','Matte Finish SPF','Dewy Finish SPF','Face Sunscreen','Body Sunscreen','After Sun','SPF Serum','SPF Lip Balm','Kids Sunscreen','Reef-Safe SPF'],
  'Body Lotion': ['Classic Body Lotion','Cocoa Butter Lotion','Almond Body Lotion','Aloe Vera Lotion','Vitamin E Lotion','Shea Butter Lotion','Lavender Lotion','Rose Body Lotion','Coconut Lotion','Argan Body Lotion','Intensive Lotion','Body Oil Lotion','In-Shower Lotion','Firming Lotion','Glow Lotion','Sensitive Skin Lotion'],
  'Toothpaste': ['Mint Fresh Toothpaste','Whitening Toothpaste','Sensitive Toothpaste','Herbal Toothpaste','Charcoal Toothpaste','Fluoride-Free Toothpaste','Kids Toothpaste','Anti-Cavity Paste','Enamel Protect Paste','Gum Care Paste','Total Care Paste','Natural Toothpaste','Neem Toothpaste','Gel Toothpaste','Bamboo Charcoal Paste','Activated Charcoal Paste'],
  'Toothbrush': ['Soft Toothbrush','Medium Toothbrush','Charcoal Toothbrush','Kids Toothbrush','Electric Toothbrush Head','Bamboo Toothbrush','Sensitive Brush','Extra Soft Brush','Compact Head Brush','Gum Care Brush','Orthodontic Brush','Travel Toothbrush','Tongue Cleaner Brush','Interdental Brush','Angled Brush','Whitening Brush'],
  'Mouthwash': ['Mint Mouthwash','Whitening Mouthwash','Sensitive Mouthwash','Anti-Bacterial Wash','Fluoride Mouthwash','Alcohol-Free Wash','Kids Mouthwash','Gum Care Wash','Fresh Breath Wash','Natural Mouthwash','Charcoal Mouthwash','Oil Pulling Wash','Herbal Mouthwash','Coconut Oil Pull','Prescription-Strength Wash','Probiotic Mouthwash'],
  'Dental Floss': ['Mint Dental Floss','Waxed Floss','Unwaxed Floss','Floss Picks','Water Flosser Refill','Eco Floss','Charcoal Floss','PTFE Floss','Biodegradable Floss','Kids Floss Picks','Ultra-Thin Floss','Wide Floss','Floss Threaders','Interdental Brushes','Satin Floss','Bamboo Floss'],
  'Soap Bars': ['Sandalwood Soap','Rose Soap','Lemon Soap','Charcoal Soap','Aloe Vera Soap','Neem Soap','Turmeric Soap','Lavender Soap','Oatmeal Soap','Goats Milk Soap','Shea Butter Soap','Tea Tree Soap','Coconut Soap','Glycerin Soap','Kojic Acid Soap','Coffee Soap'],
  'Shower Gel': ['Fresh Shower Gel','Floral Shower Gel','Mint Shower Gel','Berry Shower Gel','Coconut Shower Gel','Charcoal Body Wash','Argan Shower Gel','Rose Shower Gel','Lavender Shower Gel','Citrus Body Wash','Vanilla Shower Gel','Aloe Shower Gel','Neem Body Wash','Tea Tree Wash','Coffee Body Scrub Gel','Oat Shower Gel'],
  'Talcum Powder': ['Cool Talcum Powder','Floral Talc','Sandalwood Talc','Lavender Talc','Rose Talc','Prickly Heat Talc','Baby Talc','Medicated Talc','Sport Talc','Organic Talc','Jasmine Talc','Citrus Talc','Activated Charcoal Talc','Cornstarch Powder','Baking Soda Deodorant Powder','Anti-Fungal Talc'],
  'Deodorant': ['Original Roll-On','Sport Roll-On','Floral Roll-On','Sensitive Roll-On','Men\'s Deodorant Spray','Women\'s Deodorant Spray','Unisex Deodorant','Natural Deodorant','Charcoal Deodorant','Baking Soda Deodorant','Crystal Deodorant','Stick Deodorant','Gel Deodorant','Invisible Deodorant','48H Deodorant','72H Deodorant'],
};

const SIZES = {
  unbranded: ['250 g', '500 g', '1 kg', '2 kg', 'Per piece', 'Bunch'],
  dairy:     ['200 ml', '500 ml', '1 L', '200 g', '500 g', '1 kg'],
  meat:      ['250 g', '500 g', '1 kg', '2 kg'],
  beverage:  ['250 ml', '500 ml', '1 L', '1.25 L', '2 L', '6 × 330 ml'],
  snack:     ['50 g', '100 g', '200 g', '500 g', 'Family Pack'],
  pantry:    ['500 g', '1 kg', '2 kg', '5 kg', '500 ml', '1 L'],
  frozen:    ['200 g', '400 g', '500 g', '1 kg'],
  personal:  ['100 ml', '200 ml', '400 ml', '100 g', '200 g'],
};

const PARENT_BRAND_HINT = {
  'Fresh Produce':          'unbranded',
  'Dairy, Bakery & Eggs':   'dairy',
  'Meat & Seafood':         'meat',
  'Beverages':              'beverage',
  'Snacks & Confectionery': 'snack',
  'Pantry & Cooking':       'pantry',
  'Frozen & Ready Meals':   'frozen',
  'Personal Care':          'personal',
};

const DESC_TEMPLATES = [
  '{name} — sourced from trusted suppliers and packed with care.',
  'Premium quality {name}. {brand_phrase}A pantry essential for every household.',
  '{name} that meets our strict quality standards. {brand_phrase}',
  'Daily-use {name}. {brand_phrase}Stocked fresh, dispatched fast.',
  'Carefully selected {name}. {brand_phrase}Great value for everyday cooking.',
  'Top-rated {name} chosen by our team. {brand_phrase}',
];
const SHORT_DESCS = [
  'Quality {name} at the right price.',
  'Fresh {name} delivered to your door.',
  'Premium {name}. Stock up today.',
  '{name} — a customer favourite.',
  'Reliable {name} for everyday use.',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function findBusiness(slug) {
  const biz = await prisma.business.findUnique({ where: { slug } });
  if (!biz) {
    const list = await prisma.business.findMany({ select: { slug: true, name: true }, take: 20 });
    console.error(`✗ Business "${slug}" not found. Available:`);
    list.forEach(b => console.error(`  - ${b.slug} (${b.name})`));
    process.exit(1);
  }
  return biz;
}

// ─── Step 1: Wipe ─────────────────────────────────────────────────────────────

async function wipeAll(businessId) {
  const [products, categories] = await Promise.all([
    prisma.product.count({ where: { businessId } }),
    prisma.productCategory.count({ where: { businessId } }),
  ]);
  console.log(`  Found: ${products} products, ${categories} categories — deleting…`);

  // Delete products first (FK) then categories.
  await prisma.product.deleteMany({ where: { businessId } });
  await prisma.productCategory.deleteMany({ where: { businessId } });
  console.log('  ✓ Wiped.');
}

// ─── Step 2: Set depth ────────────────────────────────────────────────────────

async function setDepth(businessId) {
  await prisma.business.update({ where: { id: businessId }, data: { categoryMaxDepth: 3 } });
  console.log('  ✓ categoryMaxDepth = 3');
}

// ─── Step 3: Seed categories ─────────────────────────────────────────────────

async function seedCategories(businessId) {
  const leaves = [];
  for (const parent of CATEGORY_TREE) {
    const pSlug = slugify(parent.name);
    const parentRow = await prisma.productCategory.create({
      data: { businessId, name: parent.name, slug: pSlug, description: `${parent.emoji} ${parent.name}`, isPublished: true, sortOrder: 0 },
    });

    for (const sub of parent.children) {
      const sSlug = `${pSlug}-${slugify(sub.name)}`;
      const subRow = await prisma.productCategory.create({
        data: { businessId, name: sub.name, slug: sSlug, parentId: parentRow.id, isPublished: true, sortOrder: 0 },
      });

      for (const leafName of sub.children) {
        const lSlug = `${sSlug}-${slugify(leafName)}`;
        const leafRow = await prisma.productCategory.create({
          data: { businessId, name: leafName, slug: lSlug, parentId: subRow.id, isPublished: true, sortOrder: 0 },
        });
        leaves.push({ id: leafRow.id, name: leafName, parentName: parent.name, brandHint: PARENT_BRAND_HINT[parent.name], priceRange: parent.priceRange });
      }
    }
  }
  console.log(`  ✓ ${CATEGORY_TREE.length} parents, ${CATEGORY_TREE.length * 4} subs, ${leaves.length} leaves`);
  return leaves;
}

// ─── Step 4: Seed products ────────────────────────────────────────────────────

async function seedProducts(businessId, leaves, brands) {
  const PER_LEAF = 16;
  let created = 0;

  for (const leaf of leaves) {
    const variants = VARIANTS[leaf.name] || [leaf.name];
    const sizeBucket = SIZES[leaf.brandHint] || SIZES.unbranded;

    for (let i = 0; i < PER_LEAF; i++) {
      const variant = variants[i % variants.length];
      const size = rand(sizeBucket);
      const brand = leaf.brandHint === 'unbranded'
        ? (Math.random() < 0.7 ? null : rand(brands))
        : (Math.random() < 0.85 ? rand(brands) : null);
      const brandLabel = brand?.name || null;

      const name = brandLabel ? `${brandLabel} ${variant} ${size}` : `${variant} ${size}`;
      const slug = slugify(`${leaf.name}-${variant}-${i}`);

      const [minP, maxP] = leaf.priceRange;
      const priceMinor = randInt(minP, maxP);
      const hasCompare = Math.random() < 0.3;
      const comparePriceMinor = hasCompare ? Math.round(priceMinor * (1 + Math.random() * 0.15 + 0.10)) : null;
      const stockRoll = Math.random();
      const stockQty = stockRoll < 0.15 ? 0 : stockRoll < 0.40 ? null : randInt(5, 200);
      const isFeatured = Math.random() < 0.05;

      const brandPhrases = [`From ${brandLabel}. `, `By ${brandLabel}. `, `${brandLabel} quality. `];
      const phrase = brandLabel ? rand(brandPhrases) : '';
      const description = rand(DESC_TEMPLATES).replace('{name}', name).replace('{brand_phrase}', phrase);
      const shortDescription = rand(SHORT_DESCS).replace('{name}', name);

      await prisma.product.create({
        data: {
          businessId,
          categoryId: leaf.id,
          name,
          slug,
          brand: brandLabel,
          brandId: brand?.id || null,
          description,
          shortDescription,
          priceMinor,
          comparePriceMinor,
          currency: 'INR',
          discountDisplayMode: 'PERCENTAGE',
          stockQty,
          imageUrls: [],
          isPublished: true,
          isFeatured,
          sortOrder: i,
        },
      });
      created++;
      if (created % 256 === 0) console.log(`    … ${created} products`);
    }
  }
  console.log(`  ✓ ${created} products created`);
  return created;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\n=== Cleanup + Reseed: "${TARGET_SLUG}" (country=${COUNTRY}) ===\n`);

  const biz = await findBusiness(TARGET_SLUG);
  console.log(`✓ Business: ${biz.name} (${biz.id.slice(0, 8)}…)\n`);

  console.log('1. Wiping all products + categories…');
  await wipeAll(biz.id);

  console.log('\n2. Setting category depth…');
  await setDepth(biz.id);

  console.log('\n3. Seeding brand catalog…');
  const stats = await seedBrandsForBusiness(prisma, { businessId: biz.id, countryCode: COUNTRY });
  console.log(`  ✓ +${stats.familiesAdded || 0} families, +${stats.brandsAdded || 0} brands`);

  console.log('\n4. Loading brands…');
  const brands = await prisma.productBrand.findMany({ where: { businessId: biz.id, isActive: true }, select: { id: true, name: true } });
  console.log(`  ✓ ${brands.length} brands`);

  console.log('\n5. Seeding 8 × 4 × 4 category tree…');
  const leaves = await seedCategories(biz.id);

  console.log('\n6. Seeding 16 products × 128 leaves…');
  await seedProducts(biz.id, leaves, brands);

  console.log('\n=== Final counts ===');
  const [parents, subs, leafCount, productCount] = await Promise.all([
    prisma.productCategory.count({ where: { businessId: biz.id, parentId: null } }),
    prisma.productCategory.count({ where: { businessId: biz.id, parent: { parentId: null }, NOT: { parentId: null } } }),
    prisma.productCategory.count({ where: { businessId: biz.id, parent: { NOT: { parentId: null } } } }),
    prisma.product.count({ where: { businessId: biz.id } }),
  ]);
  console.log(`  Parent categories : ${parents}  (expected 8)`);
  console.log(`  Sub-categories    : ${subs}  (expected 32)`);
  console.log(`  Leaf categories   : ${leafCount}  (expected 128)`);
  console.log(`  Products          : ${productCount}  (expected 2048)`);
  console.log('\n✓ Done.\n');
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('✗ Failed:', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
