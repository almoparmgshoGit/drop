-- Hotels use the shared service list, so their amenities show with icons like a trip's and a bus's.
CREATE TABLE "HotelService" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    CONSTRAINT "HotelService_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HotelService_hotelId_serviceId_key" ON "HotelService"("hotelId", "serviceId");
ALTER TABLE "HotelService" ADD CONSTRAINT "HotelService_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HotelService" ADD CONSTRAINT "HotelService_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Each feature typed on a hotel becomes a service of the same name, or joins the one that already exists.
INSERT INTO "Service" ("id", "name", "createdAt")
SELECT gen_random_uuid()::text, "feature", CURRENT_TIMESTAMP
FROM (SELECT DISTINCT btrim("feature") AS "feature" FROM "Hotel", unnest("features") AS "feature") AS "typed"
WHERE "feature" <> ''
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "HotelService" ("id", "hotelId", "serviceId")
SELECT gen_random_uuid()::text, "Hotel"."id", "Service"."id"
FROM "Hotel", unnest("Hotel"."features") AS "feature"
JOIN "Service" ON "Service"."name" = btrim("feature")
ON CONFLICT ("hotelId", "serviceId") DO NOTHING;

ALTER TABLE "Hotel" DROP COLUMN "features";

-- A first icon for services that have none, guessed from words in their name. Staff can change any of them.
UPDATE "Service" SET "icon" = 'Wifi' WHERE "icon" IS NULL AND (lower("name") LIKE '%wifi%' OR lower("name") LIKE '%internet%' OR lower("name") LIKE '%wireless%' OR lower("name") LIKE '%واي%' OR lower("name") LIKE '%فاي%' OR lower("name") LIKE '%انترنت%' OR lower("name") LIKE '%شبكة%');
UPDATE "Service" SET "icon" = 'Usb' WHERE "icon" IS NULL AND (lower("name") LIKE '%usb%' OR lower("name") LIKE '%port%' OR lower("name") LIKE '%منفذ%');
UPDATE "Service" SET "icon" = 'PlugZap' WHERE "icon" IS NULL AND (lower("name") LIKE '%charger%' OR lower("name") LIKE '%plug%' OR lower("name") LIKE '%power%' OR lower("name") LIKE '%socket%' OR lower("name") LIKE '%outlet%' OR lower("name") LIKE '%شاحن%' OR lower("name") LIKE '%كهرباء%' OR lower("name") LIKE '%فيش%' OR lower("name") LIKE '%مقبس%');
UPDATE "Service" SET "icon" = 'BatteryCharging' WHERE "icon" IS NULL AND (lower("name") LIKE '%charging%' OR lower("name") LIKE '%battery%' OR lower("name") LIKE '%شحن%' OR lower("name") LIKE '%بطارية%');
UPDATE "Service" SET "icon" = 'Smartphone' WHERE "icon" IS NULL AND (lower("name") LIKE '%mobile%' OR lower("name") LIKE '%phone%' OR lower("name") LIKE '%جوال%' OR lower("name") LIKE '%هاتف%');
UPDATE "Service" SET "icon" = 'Phone' WHERE "icon" IS NULL AND (lower("name") LIKE '%phone%' OR lower("name") LIKE '%call%' OR lower("name") LIKE '%هاتف%' OR lower("name") LIKE '%اتصال%');
UPDATE "Service" SET "icon" = 'Tv' WHERE "icon" IS NULL AND (lower("name") LIKE '%television%' OR lower("name") LIKE '%تلفزيون%' OR lower("name") LIKE '%تلفاز%');
UPDATE "Service" SET "icon" = 'MonitorPlay' WHERE "icon" IS NULL AND (lower("name") LIKE '%screen%' OR lower("name") LIKE '%entertainment%' OR lower("name") LIKE '%movies%' OR lower("name") LIKE '%شاشة%' OR lower("name") LIKE '%ترفيه%' OR lower("name") LIKE '%أفلام%');
UPDATE "Service" SET "icon" = 'Music' WHERE "icon" IS NULL AND (lower("name") LIKE '%music%' OR lower("name") LIKE '%audio%' OR lower("name") LIKE '%موسيقى%' OR lower("name") LIKE '%صوتيات%');
UPDATE "Service" SET "icon" = 'Headphones' WHERE "icon" IS NULL AND (lower("name") LIKE '%headphones%' OR lower("name") LIKE '%earphones%' OR lower("name") LIKE '%سماعات%');
UPDATE "Service" SET "icon" = 'Mic' WHERE "icon" IS NULL AND (lower("name") LIKE '%microphone%' OR lower("name") LIKE '%ميكروفون%' OR lower("name") LIKE '%مايك%');
UPDATE "Service" SET "icon" = 'Volume2' WHERE "icon" IS NULL AND (lower("name") LIKE '%speaker%' OR lower("name") LIKE '%sound%' OR lower("name") LIKE '%سماعة%' OR lower("name") LIKE '%صوت%' OR lower("name") LIKE '%مكبر%');
UPDATE "Service" SET "icon" = 'Gamepad2' WHERE "icon" IS NULL AND (lower("name") LIKE '%games%' OR lower("name") LIKE '%ألعاب%');
UPDATE "Service" SET "icon" = 'BookOpen' WHERE "icon" IS NULL AND (lower("name") LIKE '%book%' OR lower("name") LIKE '%quran%' OR lower("name") LIKE '%reading%' OR lower("name") LIKE '%كتاب%' OR lower("name") LIKE '%مصحف%' OR lower("name") LIKE '%قراءة%');
UPDATE "Service" SET "icon" = 'Newspaper' WHERE "icon" IS NULL AND (lower("name") LIKE '%newspaper%' OR lower("name") LIKE '%جريدة%' OR lower("name") LIKE '%صحف%');
UPDATE "Service" SET "icon" = 'Camera' WHERE "icon" IS NULL AND (lower("name") LIKE '%camera%' OR lower("name") LIKE '%photography%' OR lower("name") LIKE '%كاميرا%' OR lower("name") LIKE '%تصوير%');
UPDATE "Service" SET "icon" = 'Snowflake' WHERE "icon" IS NULL AND (lower("name") LIKE '%air%' OR lower("name") LIKE '%conditioning%' OR lower("name") LIKE '%cooling%' OR lower("name") LIKE '%تكييف%' OR lower("name") LIKE '%مكيف%' OR lower("name") LIKE '%تبريد%');
UPDATE "Service" SET "icon" = 'AirVent' WHERE "icon" IS NULL AND (lower("name") LIKE '%air%' OR lower("name") LIKE '%vent%' OR lower("name") LIKE '%فتحة%' OR lower("name") LIKE '%تكييف%' OR lower("name") LIKE '%هواء%');
UPDATE "Service" SET "icon" = 'Fan' WHERE "icon" IS NULL AND (lower("name") LIKE '%fan%' OR lower("name") LIKE '%مروحة%');
UPDATE "Service" SET "icon" = 'Wind' WHERE "icon" IS NULL AND (lower("name") LIKE '%ventilation%' OR lower("name") LIKE '%air%' OR lower("name") LIKE '%تهوية%' OR lower("name") LIKE '%هواء%');
UPDATE "Service" SET "icon" = 'Thermometer' WHERE "icon" IS NULL AND (lower("name") LIKE '%heating%' OR lower("name") LIKE '%temperature%' OR lower("name") LIKE '%تدفئة%' OR lower("name") LIKE '%حرارة%');
UPDATE "Service" SET "icon" = 'Armchair' WHERE "icon" IS NULL AND (lower("name") LIKE '%seat%' OR lower("name") LIKE '%recliner%' OR lower("name") LIKE '%comfortable%' OR lower("name") LIKE '%مقعد%' OR lower("name") LIKE '%كرسي%' OR lower("name") LIKE '%مريح%');
UPDATE "Service" SET "icon" = 'Sofa' WHERE "icon" IS NULL AND (lower("name") LIKE '%lounge%' OR lower("name") LIKE '%sofa%' OR lower("name") LIKE '%صالة%' OR lower("name") LIKE '%كنب%');
UPDATE "Service" SET "icon" = 'Lamp' WHERE "icon" IS NULL AND (lower("name") LIKE '%reading%' OR lower("name") LIKE '%lamp%' OR lower("name") LIKE '%إضاءة%' OR lower("name") LIKE '%قراءة%');
UPDATE "Service" SET "icon" = 'Lightbulb' WHERE "icon" IS NULL AND (lower("name") LIKE '%lighting%' OR lower("name") LIKE '%إضاءة%');
UPDATE "Service" SET "icon" = 'Blinds' WHERE "icon" IS NULL AND (lower("name") LIKE '%curtains%' OR lower("name") LIKE '%blinds%' OR lower("name") LIKE '%ستائر%');
UPDATE "Service" SET "icon" = 'Bed' WHERE "icon" IS NULL AND (lower("name") LIKE '%bed%' OR lower("name") LIKE '%سرير%');
UPDATE "Service" SET "icon" = 'BedDouble' WHERE "icon" IS NULL AND (lower("name") LIKE '%double%' OR lower("name") LIKE '%bed%' OR lower("name") LIKE '%سرير%' OR lower("name") LIKE '%مزدوج%');
UPDATE "Service" SET "icon" = 'BedSingle' WHERE "icon" IS NULL AND (lower("name") LIKE '%single%' OR lower("name") LIKE '%bed%' OR lower("name") LIKE '%سرير%' OR lower("name") LIKE '%مفرد%');
UPDATE "Service" SET "icon" = 'Hotel' WHERE "icon" IS NULL AND (lower("name") LIKE '%hotel%' OR lower("name") LIKE '%accommodation%' OR lower("name") LIKE '%فندق%' OR lower("name") LIKE '%سكن%' OR lower("name") LIKE '%إقامة%');
UPDATE "Service" SET "icon" = 'Building2' WHERE "icon" IS NULL AND (lower("name") LIKE '%building%' OR lower("name") LIKE '%tower%' OR lower("name") LIKE '%مبنى%' OR lower("name") LIKE '%برج%');
UPDATE "Service" SET "icon" = 'ConciergeBell' WHERE "icon" IS NULL AND (lower("name") LIKE '%reception%' OR lower("name") LIKE '%concierge%' OR lower("name") LIKE '%room%' OR lower("name") LIKE '%service%' OR lower("name") LIKE '%استقبال%' OR lower("name") LIKE '%خدمة%' OR lower("name") LIKE '%الغرف%');
UPDATE "Service" SET "icon" = 'KeyRound' WHERE "icon" IS NULL AND (lower("name") LIKE '%room%' OR lower("name") LIKE '%key%' OR lower("name") LIKE '%مفتاح%' OR lower("name") LIKE '%غرفة%');
UPDATE "Service" SET "icon" = 'DoorOpen' WHERE "icon" IS NULL AND (lower("name") LIKE '%entrance%' OR lower("name") LIKE '%door%' OR lower("name") LIKE '%مدخل%' OR lower("name") LIKE '%باب%');
UPDATE "Service" SET "icon" = 'Bath' WHERE "icon" IS NULL AND (lower("name") LIKE '%bath%' OR lower("name") LIKE '%bathroom%' OR lower("name") LIKE '%حمام%' OR lower("name") LIKE '%بانيو%');
UPDATE "Service" SET "icon" = 'ShowerHead' WHERE "icon" IS NULL AND (lower("name") LIKE '%shower%' OR lower("name") LIKE '%استحمام%');
UPDATE "Service" SET "icon" = 'Toilet' WHERE "icon" IS NULL AND (lower("name") LIKE '%toilet%' OR lower("name") LIKE '%restroom%' OR lower("name") LIKE '%دورة%' OR lower("name") LIKE '%مياه%');
UPDATE "Service" SET "icon" = 'WashingMachine' WHERE "icon" IS NULL AND (lower("name") LIKE '%laundry%' OR lower("name") LIKE '%washing%' OR lower("name") LIKE '%غسيل%' OR lower("name") LIKE '%ملابس%' OR lower("name") LIKE '%مغسلة%');
UPDATE "Service" SET "icon" = 'Shirt' WHERE "icon" IS NULL AND (lower("name") LIKE '%clothes%' OR lower("name") LIKE '%ironing%' OR lower("name") LIKE '%ihram%' OR lower("name") LIKE '%ملابس%' OR lower("name") LIKE '%إحرام%');
UPDATE "Service" SET "icon" = 'SprayCan' WHERE "icon" IS NULL AND (lower("name") LIKE '%cleaning%' OR lower("name") LIKE '%housekeeping%' OR lower("name") LIKE '%تنظيف%');
UPDATE "Service" SET "icon" = 'Sparkles' WHERE "icon" IS NULL AND (lower("name") LIKE '%clean%' OR lower("name") LIKE '%new%' OR lower("name") LIKE '%نظافة%' OR lower("name") LIKE '%جديد%');
UPDATE "Service" SET "icon" = 'Refrigerator' WHERE "icon" IS NULL AND (lower("name") LIKE '%fridge%' OR lower("name") LIKE '%refrigerator%' OR lower("name") LIKE '%ثلاجة%');
UPDATE "Service" SET "icon" = 'Microwave' WHERE "icon" IS NULL AND (lower("name") LIKE '%microwave%' OR lower("name") LIKE '%مايكرويف%');
UPDATE "Service" SET "icon" = 'CookingPot' WHERE "icon" IS NULL AND (lower("name") LIKE '%kitchen%' OR lower("name") LIKE '%cooking%' OR lower("name") LIKE '%مطبخ%' OR lower("name") LIKE '%طبخ%');
UPDATE "Service" SET "icon" = 'Waves' WHERE "icon" IS NULL AND (lower("name") LIKE '%swimming%' OR lower("name") LIKE '%pool%' OR lower("name") LIKE '%مسبح%' OR lower("name") LIKE '%سباحة%');
UPDATE "Service" SET "icon" = 'Dumbbell' WHERE "icon" IS NULL AND (lower("name") LIKE '%gym%' OR lower("name") LIKE '%fitness%' OR lower("name") LIKE '%نادي%' OR lower("name") LIKE '%رياضي%');
UPDATE "Service" SET "icon" = 'Trees' WHERE "icon" IS NULL AND (lower("name") LIKE '%garden%' OR lower("name") LIKE '%park%' OR lower("name") LIKE '%حديقة%');
UPDATE "Service" SET "icon" = 'Coffee' WHERE "icon" IS NULL AND (lower("name") LIKE '%coffee%' OR lower("name") LIKE '%tea%' OR lower("name") LIKE '%قهوة%' OR lower("name") LIKE '%شاي%');
UPDATE "Service" SET "icon" = 'CupSoda' WHERE "icon" IS NULL AND (lower("name") LIKE '%soft%' OR lower("name") LIKE '%drinks%' OR lower("name") LIKE '%juice%' OR lower("name") LIKE '%مشروبات%' OR lower("name") LIKE '%عصير%');
UPDATE "Service" SET "icon" = 'GlassWater' WHERE "icon" IS NULL AND (lower("name") LIKE '%water%' OR lower("name") LIKE '%bottle%' OR lower("name") LIKE '%ماء%' OR lower("name") LIKE '%مياه%');
UPDATE "Service" SET "icon" = 'Droplets' WHERE "icon" IS NULL AND (lower("name") LIKE '%zamzam%' OR lower("name") LIKE '%water%' OR lower("name") LIKE '%زمزم%' OR lower("name") LIKE '%ماء%');
UPDATE "Service" SET "icon" = 'Milk' WHERE "icon" IS NULL AND (lower("name") LIKE '%milk%' OR lower("name") LIKE '%حليب%');
UPDATE "Service" SET "icon" = 'Utensils' WHERE "icon" IS NULL AND (lower("name") LIKE '%meals%' OR lower("name") LIKE '%food%' OR lower("name") LIKE '%وجبات%' OR lower("name") LIKE '%طعام%' OR lower("name") LIKE '%أكل%');
UPDATE "Service" SET "icon" = 'UtensilsCrossed' WHERE "icon" IS NULL AND (lower("name") LIKE '%restaurant%' OR lower("name") LIKE '%buffet%' OR lower("name") LIKE '%مطعم%' OR lower("name") LIKE '%بوفيه%');
UPDATE "Service" SET "icon" = 'Croissant' WHERE "icon" IS NULL AND (lower("name") LIKE '%breakfast%' OR lower("name") LIKE '%إفطار%' OR lower("name") LIKE '%فطور%');
UPDATE "Service" SET "icon" = 'Sandwich' WHERE "icon" IS NULL AND (lower("name") LIKE '%snacks%' OR lower("name") LIKE '%sandwich%' OR lower("name") LIKE '%سندويتش%' OR lower("name") LIKE '%وجبة%' OR lower("name") LIKE '%خفيفة%');
UPDATE "Service" SET "icon" = 'Soup' WHERE "icon" IS NULL AND (lower("name") LIKE '%dinner%' OR lower("name") LIKE '%lunch%' OR lower("name") LIKE '%soup%' OR lower("name") LIKE '%عشاء%' OR lower("name") LIKE '%غداء%' OR lower("name") LIKE '%شوربة%');
UPDATE "Service" SET "icon" = 'Pizza' WHERE "icon" IS NULL AND (lower("name") LIKE '%pizza%' OR lower("name") LIKE '%بيتزا%');
UPDATE "Service" SET "icon" = 'Apple' WHERE "icon" IS NULL AND (lower("name") LIKE '%fruit%' OR lower("name") LIKE '%فاكهة%');
UPDATE "Service" SET "icon" = 'Cookie' WHERE "icon" IS NULL AND (lower("name") LIKE '%sweets%' OR lower("name") LIKE '%biscuits%' OR lower("name") LIKE '%حلويات%' OR lower("name") LIKE '%بسكويت%');
UPDATE "Service" SET "icon" = 'CakeSlice' WHERE "icon" IS NULL AND (lower("name") LIKE '%dessert%' OR lower("name") LIKE '%cake%' OR lower("name") LIKE '%حلا%' OR lower("name") LIKE '%كيك%');
UPDATE "Service" SET "icon" = 'Bus' WHERE "icon" IS NULL AND (lower("name") LIKE '%bus%' OR lower("name") LIKE '%transport%' OR lower("name") LIKE '%باص%' OR lower("name") LIKE '%حافلة%' OR lower("name") LIKE '%نقل%' OR lower("name") LIKE '%مواصلات%');
UPDATE "Service" SET "icon" = 'BusFront' WHERE "icon" IS NULL AND (lower("name") LIKE '%coach%' OR lower("name") LIKE '%bus%' OR lower("name") LIKE '%حافلة%');
UPDATE "Service" SET "icon" = 'Car' WHERE "icon" IS NULL AND (lower("name") LIKE '%car%' OR lower("name") LIKE '%taxi%' OR lower("name") LIKE '%transfer%' OR lower("name") LIKE '%سيارة%' OR lower("name") LIKE '%تاكسي%' OR lower("name") LIKE '%توصيل%');
UPDATE "Service" SET "icon" = 'Plane' WHERE "icon" IS NULL AND (lower("name") LIKE '%flight%' OR lower("name") LIKE '%airport%' OR lower("name") LIKE '%طيران%' OR lower("name") LIKE '%مطار%');
UPDATE "Service" SET "icon" = 'TrainFront' WHERE "icon" IS NULL AND (lower("name") LIKE '%train%' OR lower("name") LIKE '%قطار%');
UPDATE "Service" SET "icon" = 'CircleParking' WHERE "icon" IS NULL AND (lower("name") LIKE '%parking%' OR lower("name") LIKE '%موقف%' OR lower("name") LIKE '%مواقف%');
UPDATE "Service" SET "icon" = 'Fuel' WHERE "icon" IS NULL AND (lower("name") LIKE '%fuel%' OR lower("name") LIKE '%وقود%');
UPDATE "Service" SET "icon" = 'Luggage' WHERE "icon" IS NULL AND (lower("name") LIKE '%luggage%' OR lower("name") LIKE '%suitcase%' OR lower("name") LIKE '%أمتعة%' OR lower("name") LIKE '%شنط%' OR lower("name") LIKE '%حقائب%');
UPDATE "Service" SET "icon" = 'Backpack' WHERE "icon" IS NULL AND (lower("name") LIKE '%bag%' OR lower("name") LIKE '%backpack%' OR lower("name") LIKE '%حقيبة%');
UPDATE "Service" SET "icon" = 'MapPin' WHERE "icon" IS NULL AND (lower("name") LIKE '%location%' OR lower("name") LIKE '%pickup%' OR lower("name") LIKE '%موقع%' OR lower("name") LIKE '%نقطة%');
UPDATE "Service" SET "icon" = 'Map' WHERE "icon" IS NULL AND (lower("name") LIKE '%map%' OR lower("name") LIKE '%tour%' OR lower("name") LIKE '%خريطة%' OR lower("name") LIKE '%جولة%');
UPDATE "Service" SET "icon" = 'Navigation' WHERE "icon" IS NULL AND (lower("name") LIKE '%gps%' OR lower("name") LIKE '%navigation%' OR lower("name") LIKE '%tracking%' OR lower("name") LIKE '%ملاحة%' OR lower("name") LIKE '%تتبع%');
UPDATE "Service" SET "icon" = 'Compass' WHERE "icon" IS NULL AND (lower("name") LIKE '%qibla%' OR lower("name") LIKE '%direction%' OR lower("name") LIKE '%قبلة%' OR lower("name") LIKE '%اتجاه%');
UPDATE "Service" SET "icon" = 'Route' WHERE "icon" IS NULL AND (lower("name") LIKE '%route%' OR lower("name") LIKE '%مسار%' OR lower("name") LIKE '%طريق%');
UPDATE "Service" SET "icon" = 'Footprints' WHERE "icon" IS NULL AND (lower("name") LIKE '%walking%' OR lower("name") LIKE '%distance%' OR lower("name") LIKE '%near%' OR lower("name") LIKE '%مشي%' OR lower("name") LIKE '%قريب%');
UPDATE "Service" SET "icon" = 'Landmark' WHERE "icon" IS NULL AND (lower("name") LIKE '%landmark%' OR lower("name") LIKE '%haram%' OR lower("name") LIKE '%mosque%' OR lower("name") LIKE '%معلم%' OR lower("name") LIKE '%حرم%' OR lower("name") LIKE '%مسجد%');
UPDATE "Service" SET "icon" = 'Tent' WHERE "icon" IS NULL AND (lower("name") LIKE '%tent%' OR lower("name") LIKE '%camp%' OR lower("name") LIKE '%خيمة%' OR lower("name") LIKE '%مخيم%');
UPDATE "Service" SET "icon" = 'Mountain' WHERE "icon" IS NULL AND (lower("name") LIKE '%mountain%' OR lower("name") LIKE '%جبل%');
UPDATE "Service" SET "icon" = 'Clock' WHERE "icon" IS NULL AND (lower("name") LIKE '%time%' OR lower("name") LIKE '%hours%' OR lower("name") LIKE '%وقت%' OR lower("name") LIKE '%ساعة%');
UPDATE "Service" SET "icon" = 'Ticket' WHERE "icon" IS NULL AND (lower("name") LIKE '%ticket%' OR lower("name") LIKE '%تذكرة%');
UPDATE "Service" SET "icon" = 'BriefcaseMedical' WHERE "icon" IS NULL AND (lower("name") LIKE '%first%' OR lower("name") LIKE '%aid%' OR lower("name") LIKE '%kit%' OR lower("name") LIKE '%إسعافات%' OR lower("name") LIKE '%أولية%');
UPDATE "Service" SET "icon" = 'Stethoscope' WHERE "icon" IS NULL AND (lower("name") LIKE '%doctor%' OR lower("name") LIKE '%medical%' OR lower("name") LIKE '%طبيب%' OR lower("name") LIKE '%رعاية%' OR lower("name") LIKE '%طبية%');
UPDATE "Service" SET "icon" = 'HeartPulse' WHERE "icon" IS NULL AND (lower("name") LIKE '%health%' OR lower("name") LIKE '%صحة%');
UPDATE "Service" SET "icon" = 'Pill' WHERE "icon" IS NULL AND (lower("name") LIKE '%medicine%' OR lower("name") LIKE '%دواء%' OR lower("name") LIKE '%أدوية%');
UPDATE "Service" SET "icon" = 'ShieldCheck' WHERE "icon" IS NULL AND (lower("name") LIKE '%insurance%' OR lower("name") LIKE '%safety%' OR lower("name") LIKE '%تأمين%' OR lower("name") LIKE '%أمان%');
UPDATE "Service" SET "icon" = 'FireExtinguisher' WHERE "icon" IS NULL AND (lower("name") LIKE '%fire%' OR lower("name") LIKE '%extinguisher%' OR lower("name") LIKE '%طفاية%' OR lower("name") LIKE '%حريق%');
UPDATE "Service" SET "icon" = 'Cctv' WHERE "icon" IS NULL AND (lower("name") LIKE '%cctv%' OR lower("name") LIKE '%camera%' OR lower("name") LIKE '%surveillance%' OR lower("name") LIKE '%كاميرا%' OR lower("name") LIKE '%مراقبة%');
UPDATE "Service" SET "icon" = 'Lock' WHERE "icon" IS NULL AND (lower("name") LIKE '%safe%' OR lower("name") LIKE '%locker%' OR lower("name") LIKE '%خزنة%' OR lower("name") LIKE '%قفل%');
UPDATE "Service" SET "icon" = 'CigaretteOff' WHERE "icon" IS NULL AND (lower("name") LIKE '%smoking%' OR lower("name") LIKE '%ممنوع%' OR lower("name") LIKE '%التدخين%');
UPDATE "Service" SET "icon" = 'Umbrella' WHERE "icon" IS NULL AND (lower("name") LIKE '%umbrella%' OR lower("name") LIKE '%shade%' OR lower("name") LIKE '%مظلة%');
UPDATE "Service" SET "icon" = 'Accessibility' WHERE "icon" IS NULL AND (lower("name") LIKE '%wheelchair%' OR lower("name") LIKE '%accessible%' OR lower("name") LIKE '%disabled%' OR lower("name") LIKE '%ذوي%' OR lower("name") LIKE '%الإعاقة%' OR lower("name") LIKE '%كرسي%' OR lower("name") LIKE '%متحرك%');
UPDATE "Service" SET "icon" = 'Baby' WHERE "icon" IS NULL AND (lower("name") LIKE '%baby%' OR lower("name") LIKE '%kids%' OR lower("name") LIKE '%children%' OR lower("name") LIKE '%أطفال%' OR lower("name") LIKE '%رضيع%');
UPDATE "Service" SET "icon" = 'Users' WHERE "icon" IS NULL AND (lower("name") LIKE '%group%' OR lower("name") LIKE '%family%' OR lower("name") LIKE '%عائلة%' OR lower("name") LIKE '%مجموعة%');
UPDATE "Service" SET "icon" = 'UserCheck' WHERE "icon" IS NULL AND (lower("name") LIKE '%supervisor%' OR lower("name") LIKE '%guide%' OR lower("name") LIKE '%مشرف%' OR lower("name") LIKE '%مرشد%');
UPDATE "Service" SET "icon" = 'Headset' WHERE "icon" IS NULL AND (lower("name") LIKE '%customer%' OR lower("name") LIKE '%service%' OR lower("name") LIKE '%support%' OR lower("name") LIKE '%خدمة%' OR lower("name") LIKE '%عملاء%' OR lower("name") LIKE '%دعم%');
UPDATE "Service" SET "icon" = 'MessageCircle' WHERE "icon" IS NULL AND (lower("name") LIKE '%chat%' OR lower("name") LIKE '%محادثة%');
UPDATE "Service" SET "icon" = 'Languages' WHERE "icon" IS NULL AND (lower("name") LIKE '%translator%' OR lower("name") LIKE '%languages%' OR lower("name") LIKE '%مترجم%' OR lower("name") LIKE '%لغات%');
UPDATE "Service" SET "icon" = 'HandHeart' WHERE "icon" IS NULL AND (lower("name") LIKE '%hospitality%' OR lower("name") LIKE '%care%' OR lower("name") LIKE '%ضيافة%' OR lower("name") LIKE '%رعاية%');
UPDATE "Service" SET "icon" = 'Scissors' WHERE "icon" IS NULL AND (lower("name") LIKE '%barber%' OR lower("name") LIKE '%haircut%' OR lower("name") LIKE '%حلاقة%' OR lower("name") LIKE '%حلاق%');
UPDATE "Service" SET "icon" = 'Bell' WHERE "icon" IS NULL AND (lower("name") LIKE '%service%' OR lower("name") LIKE '%bell%' OR lower("name") LIKE '%خدمة%' OR lower("name") LIKE '%جرس%');
UPDATE "Service" SET "icon" = 'Gift' WHERE "icon" IS NULL AND (lower("name") LIKE '%gift%' OR lower("name") LIKE '%هدية%');
UPDATE "Service" SET "icon" = 'Crown' WHERE "icon" IS NULL AND (lower("name") LIKE '%vip%' OR lower("name") LIKE '%كبار%' OR lower("name") LIKE '%الشخصيات%');
UPDATE "Service" SET "icon" = 'Gem' WHERE "icon" IS NULL AND (lower("name") LIKE '%luxury%' OR lower("name") LIKE '%فاخر%');
UPDATE "Service" SET "icon" = 'Award' WHERE "icon" IS NULL AND (lower("name") LIKE '%premium%' OR lower("name") LIKE '%مميز%');
UPDATE "Service" SET "icon" = 'BadgeCheck' WHERE "icon" IS NULL AND (lower("name") LIKE '%verified%' OR lower("name") LIKE '%official%' OR lower("name") LIKE '%معتمد%' OR lower("name") LIKE '%رسمي%');
UPDATE "Service" SET "icon" = 'Star' WHERE "icon" IS NULL AND (lower("name") LIKE '%rating%' OR lower("name") LIKE '%star%' OR lower("name") LIKE '%نجمة%' OR lower("name") LIKE '%تقييم%');
UPDATE "Service" SET "icon" = 'Moon' WHERE "icon" IS NULL AND (lower("name") LIKE '%night%' OR lower("name") LIKE '%ليل%');
UPDATE "Service" SET "icon" = 'Sun' WHERE "icon" IS NULL AND (lower("name") LIKE '%day%' OR lower("name") LIKE '%نهار%');
UPDATE "Service" SET "icon" = 'Percent' WHERE "icon" IS NULL AND (lower("name") LIKE '%discount%' OR lower("name") LIKE '%خصم%');
UPDATE "Service" SET "icon" = 'CreditCard' WHERE "icon" IS NULL AND (lower("name") LIKE '%card%' OR lower("name") LIKE '%payment%' OR lower("name") LIKE '%بطاقة%' OR lower("name") LIKE '%دفع%');
UPDATE "Service" SET "icon" = 'Banknote' WHERE "icon" IS NULL AND (lower("name") LIKE '%cash%' OR lower("name") LIKE '%نقد%' OR lower("name") LIKE '%كاش%');
UPDATE "Service" SET "icon" = 'Check' WHERE "icon" IS NULL AND (lower("name") LIKE '%general%' OR lower("name") LIKE '%included%' OR lower("name") LIKE '%عام%' OR lower("name") LIKE '%مشمول%');
