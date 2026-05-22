import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};

const {
    startUrls = [{ url: 'https://bookingcare.vn/' }],
    maxRequestsPerCrawl = 200,
    maxDoctorProfiles = 100,
    sourceSite = 'bookingcare',
} = input;

const TITLES = [
    'GS.TS.BS',
    'PGS.TS.BS',
    'GS.TS',
    'PGS.TS',
    'TS.BS',
    'ThS.BS',
    'BSCKII',
    'BS CKII',
    'BSCKI',
    'BS CKI',
    'BSNT',
    'Bác sĩ',
    'BS',
];

let pushedDoctors = 0;

const normalizeWhitespace = (value = '') => value.replace(/\s+/g, ' ').trim();
const stripHtml = (value = '') => normalizeWhitespace(value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' '));

const absoluteUrl = (value, baseUrl) => {
    if (!value) return null;
    try {
        return new URL(value, baseUrl).href;
    } catch {
        return null;
    }
};

const hashHtml = (html = '') => createHash('sha256').update(html, 'utf8').digest('hex');

const moneyToNumber = (text = '') => {
    const digits = text.replace(/[^\d]/g, '');
    if (!digits) return null;
    return Number(digits);
};

const parseYearsOfExperience = (text = '') => {
    const match = text.match(/(\d{1,2})\s*năm\s+kinh\s+nghiệm/i);
    return match ? Number(match[1]) : null;
};

const parsePriceFromText = (text = '') => {
    const amount = moneyToNumber(text);
    if (amount === null) return null;
    return {
        amount,
        currency: text.includes('đ') || text.toLowerCase().includes('vnd') ? 'VND' : null,
        rawText: normalizeWhitespace(text) || null,
    };
};

const extractDoctorIdFromUrl = (url = '') => {
    const match = url.match(/-i(\d+)(?:[/?#]|$)/i);
    if (match) return match[1];
    const fallback = url.match(/i(\d+)(?:[/?#]|$)/i);
    return fallback ? fallback[1] : null;
};

const getSlugFromUrl = (url = '') => {
    try {
        const pathname = new URL(url).pathname;
        const segment = pathname.split('/').filter(Boolean).pop() || '';
        return segment.replace(/-i\d+$/i, '');
    } catch {
        return '';
    }
};

const splitProfessionalTitle = (fullName = '') => {
    const normalizedName = normalizeWhitespace(fullName);
    const normalizedTitle = TITLES.find((prefix) => normalizedName.toUpperCase().startsWith(prefix.toUpperCase()));
    if (!normalizedTitle) {
        return {
            professionalTitle: null,
            fullName: normalizedName || null,
        };
    }

    const nameOnly = normalizeWhitespace(normalizedName.slice(normalizedTitle.length).replace(/^[-,.: ]+/, ''));
    return {
        professionalTitle: normalizedTitle,
        fullName: nameOnly || normalizedName || null,
    };
};

const collectListAfterHeading = ($, headingRegex) => {
    const heading = $('h2, h3, h4, strong')
        .filter((_, el) => headingRegex.test(normalizeWhitespace($(el).text())))
        .first();

    if (!heading.length) return [];

    const list = heading.parent().nextAll('ul').first();
    if (!list.length) return [];

    return list
        .find('li')
        .map((_, li) => normalizeWhitespace($(li).text()))
        .get()
        .filter(Boolean);
};

const extractRawJson = ($) => {
    const nextDataText = $('#__NEXT_DATA__').first().html();
    if (nextDataText) {
        try {
            return JSON.parse(nextDataText);
        } catch {
            // Fallback sang ld+json bên dưới
        }
    }

    const ldJsonList = $('script[type="application/ld+json"]')
        .map((_, script) => normalizeWhitespace($(script).html() || ''))
        .get()
        .filter(Boolean);

    if (!ldJsonList.length) return null;

    return ldJsonList.map((item) => {
        try {
            return JSON.parse(item);
        } catch {
            return item;
        }
    });
};

const extractScheduleEntries = (lichkham) => {
    if (!lichkham || typeof lichkham !== 'object') return [];

    const entries = [];
    for (const [weekdayKey, dayValue] of Object.entries(lichkham)) {
        const weekday = Number(weekdayKey);
        const sessions = dayValue?.buoi;
        if (!sessions || typeof sessions !== 'object') continue;

        for (const session of Object.values(sessions)) {
            if (!session || typeof session !== 'object') continue;
            entries.push({ weekday: Number.isNaN(weekday) ? null : weekday, session });
        }
    }
    return entries;
};

const extractWorkplaceFromSchedule = (lichkham) => {
    const entries = extractScheduleEntries(lichkham);
    for (const entry of entries) {
        const noikham = entry.session?.noikham;
        const name = normalizeWhitespace(noikham?.ten || '');
        if (!name || /^cơ sở y tế$/i.test(name) || /^chọn bệnh viện phòng khám$/i.test(name)) continue;

        return {
            workplaceName: name,
            workplaceAddressText: normalizeWhitespace(noikham?.diachi || '') || null,
            weekday: entry.weekday,
        };
    }
    return {
        workplaceName: null,
        workplaceAddressText: null,
        weekday: null,
    };
};

const extractConsultationFeeFromSchedule = (lichkham) => {
    const entries = extractScheduleEntries(lichkham);
    const directPrices = [];
    const priceTexts = [];

    for (const entry of entries) {
        const session = entry.session;
        if (Number.isFinite(session?.gia_thapnhat)) directPrices.push(Number(session.gia_thapnhat));
        if (Number.isFinite(session?.fee)) directPrices.push(Number(session.fee));
        if (typeof session?.fee_text === 'string' && normalizeWhitespace(session.fee_text)) {
            priceTexts.push(normalizeWhitespace(session.fee_text));
        }

        const giaChiTiet = session?.gia_chitiet;
        if (!giaChiTiet || typeof giaChiTiet !== 'object') continue;

        for (const group of Object.values(giaChiTiet)) {
            const details = Array.isArray(group?.dl) ? group.dl : [];
            for (const detail of details) {
                const isConsultation = /giá khám/i.test(detail?.ten || '') || detail?.batbuoc === 1;
                if (!isConsultation) continue;
                if (Number.isFinite(detail?.gia_thapnhat)) directPrices.push(Number(detail.gia_thapnhat));
                if (Number.isFinite(detail?.gia_caonhat)) directPrices.push(Number(detail.gia_caonhat));
            }
        }
    }

    const positivePrices = directPrices.filter((value) => Number.isFinite(value) && value > 0);
    const finalAmount = positivePrices.length ? Math.min(...positivePrices) : null;

    if (finalAmount !== null) {
        return {
            amount: finalAmount,
            currency: 'VND',
            rawText: `${finalAmount}đ`,
        };
    }

    const fromText = priceTexts.map(parsePriceFromText).find((item) => item?.amount !== null);
    return fromText || { amount: null, currency: null, rawText: priceTexts[0] || null };
};

const extractSlotsFromSchedule = (lichkham) => {
    const slotRegex = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/;
    const entries = extractScheduleEntries(lichkham);
    const slots = [];

    for (const entry of entries) {
        const session = entry.session;
        const timeSlots = Array.isArray(session?.thoigian) ? session.thoigian : [];

        for (const slot of timeSlots) {
            const range = normalizeWhitespace(slot?.thoigian || slot?.hienthi || '');
            const match = range.match(slotRegex);
            if (!match) continue;

            slots.push({
                date: null,
                weekday: entry.weekday,
                startAt: match[1],
                endAt: match[2],
                maxBookings: null,
                source: 'crawl',
                sourceSlotId: slot?.ma ? String(slot.ma) : null,
                bookingUrl: slot?.lk || null,
                availabilityStatus: slot?.tinhtrang === 0 ? 'available' : 'unavailable',
            });
        }
    }

    const unique = new Map();
    for (const slot of slots) {
        unique.set(`${slot.weekday ?? 'unknown'}|${slot.startAt}|${slot.endAt}|${slot.sourceSlotId ?? 'none'}`, slot);
    }
    return [...unique.values()];
};

const buildWeeklyScheduleText = (lichkham) => {
    const entries = extractScheduleEntries(lichkham);
    const weekdays = [...new Set(entries.map((item) => item.weekday).filter((value) => Number.isFinite(value)))].sort(
        (a, b) => a - b,
    );
    if (!weekdays.length) return null;
    return `Lịch theo thứ: ${weekdays.join(', ')}`;
};

const isLikelyDoctorPage = ({ url, fullName, pageModule }) => {
    if (pageModule && pageModule !== 'doctor') return false;

    const slug = getSlugFromUrl(url);
    const bySlug = /(bac-si|bs-|pgs|gs|ts|ths|chuyen-gia)/i.test(slug);
    const byName = /(bác sĩ|bs|pgs|gs|ts|ths)/i.test(fullName || '');
    return bySlug || byName;
};

const shouldEnqueueUrl = (url = '') => {
    try {
        const parsed = new URL(url);
        if (!/bookingcare\.vn$/i.test(parsed.hostname)) return false;

        const pathname = parsed.pathname || '/';
        if (pathname === '/') return true;

        // Ưu tiên enqueue URL có mã -i<id> (có thể có hậu tố như -k4).
        if (/-i\d+(?:[-/?#]|$)/i.test(pathname)) return true;

        // Giữ lại một số đường dẫn listing để mở rộng tập URL theo domain.
        return (
            pathname.startsWith('/kham-chuyen-khoa') ||
            pathname.startsWith('/co-so-y-te') ||
            pathname.startsWith('/dich-vu-y-te') ||
            pathname.startsWith('/bac-si') ||
            pathname.startsWith('/tim-kiem')
        );
    } catch {
        return false;
    }
};

const toStartUrls = (value) => {
    if (!Array.isArray(value)) return [{ url: 'https://bookingcare.vn/' }];
    return value
        .map((item) => (typeof item === 'string' ? { url: item } : item))
        .filter((item) => item?.url);
};

const pickDoctorPayload = (nextData) => {
    const pageProps = nextData?.props?.pageProps || {};
    const primaryData = pageProps?.data || {};
    const candidates = [
        primaryData?.data?.data,
        primaryData?.data,
        primaryData,
        pageProps?.data?.data,
        pageProps?.data,
        nextData?.props?.initialProps?.pageProps?.data?.data,
        nextData?.props?.initialProps?.pageProps?.data,
    ];

    return candidates.find((item) => item && typeof item === 'object' && (item.ma || item.ten || item.lichkham)) || null;
};

const pickPageMeta = (nextData) => {
    const pageProps = nextData?.props?.pageProps || {};
    const primaryData = pageProps?.data || {};
    const stat = primaryData?.stat || pageProps?.stat || null;
    const seo = primaryData?.seo || pageProps?.seo || null;
    return {
        stat,
        seo,
    };
};

const seedUrls = toStartUrls(startUrls);

log.info(`Start URLs: ${seedUrls.map((item) => item.url).join(', ')}`);
log.info(`maxRequestsPerCrawl=${maxRequestsPerCrawl}, maxDoctorProfiles=${maxDoctorProfiles}`);

const crawler = new CheerioCrawler({
    maxRequestsPerCrawl,

    async requestHandler({ request, $, enqueueLinks }) {
        const url = request.loadedUrl || request.url;
        const hasPotentialDoctorId = /bookingcare\.vn\/.+-i\d+/i.test(url);

        log.info(`Đang xử lý: ${url} (hasDoctorId=${hasPotentialDoctorId})`);

        if (hasPotentialDoctorId && pushedDoctors < maxDoctorProfiles) {
            const nextData = extractRawJson($);
            const { stat, seo } = pickPageMeta(nextData);
            const doctorPayload = pickDoctorPayload(nextData);

            if (!doctorPayload || typeof doctorPayload !== 'object') {
                log.debug(`Bỏ qua URL do thiếu doctor payload: ${url}`);
            } else {
                const rawName = normalizeWhitespace(doctorPayload.ten || $('h1').first().text());
                const { professionalTitle, fullName } = splitProfessionalTitle(rawName);

                if (!isLikelyDoctorPage({ url, fullName: rawName, pageModule: stat?.pageModule })) {
                    log.info(`Bỏ qua URL không phải trang bác sĩ sạch: ${url}`);
                } else {
                    const sourceDoctorId = String(doctorPayload.ma || extractDoctorIdFromUrl(url) || '');
                    const crawledAt = new Date().toISOString();
                    const rawHtmlHash = hashHtml($.html());

                    const specialties = (Array.isArray(doctorPayload.chuyenkhoa) ? doctorPayload.chuyenkhoa : [])
                        .map((specialty, index) => ({
                            name: normalizeWhitespace(specialty?.ten || ''),
                            isPrimary: index === 0,
                        }))
                        .filter((specialty) => specialty.name);

                    const workplace = extractWorkplaceFromSchedule(doctorPayload.lichkham);
                    const consultationFee = extractConsultationFeeFromSchedule(doctorPayload.lichkham);
                    const slots = extractSlotsFromSchedule(doctorPayload.lichkham);
                    const noidungHtml = typeof doctorPayload.noidung === 'string' ? doctorPayload.noidung : '';

                    const normalized = {
                        sourceSite,
                        sourceDoctorId: sourceDoctorId || null,
                        sourceUrl: url,
                        crawledAt,
                        rawHtmlHash,
                        fullName: fullName || rawName || null,
                        professionalTitle,
                        avatarUrl: absoluteUrl(doctorPayload.anh || null, url),
                        bio: stripHtml(doctorPayload.tomtat || seo?.description || '') || null,
                        yearsOfExperience: parseYearsOfExperience(stripHtml(doctorPayload.tomtat || doctorPayload.noidung || '')),
                        specialties,
                        workplaceName: workplace.workplaceName,
                        workplaceAddressText: workplace.workplaceAddressText,
                        province: normalizeWhitespace(doctorPayload.tinhthanh || '') || null,
                        district: null,
                        ward: null,
                        lat: null,
                        lng: null,
                        consultationFee,
                        education: collectListAfterHeading($, /quá trình đào tạo/i),
                        certifications: collectListAfterHeading($, /chứng chỉ|chứng nhận/i),
                        experiences: collectListAfterHeading($, /quá trình công tác/i),
                        services: collectListAfterHeading($, /nhận khám và điều trị|dịch vụ/i),
                        treatments: collectListAfterHeading($, /điều trị/i),
                        languages: [],
                        highlights: [],
                        weeklyScheduleText: slots.length ? null : buildWeeklyScheduleText(doctorPayload.lichkham),
                        slots,
                    };

                    const rawPayloadKey = `raw-${sourceSite}-${sourceDoctorId || createHash('sha1').update(url).digest('hex').slice(0, 12)}`;
                    await Actor.setValue(rawPayloadKey, {
                        sourceSite,
                        sourceDoctorId: sourceDoctorId || null,
                        sourceUrl: url,
                        crawledAt,
                        pageModule: stat?.pageModule || null,
                        noidungHtml,
                        rawJson: nextData,
                    });

                    await Actor.pushData({
                        normalized,
                        raw: {
                            sourceSite,
                            sourceDoctorId: sourceDoctorId || null,
                            sourceUrl: url,
                            crawledAt,
                            pageModule: stat?.pageModule || null,
                            rawHtmlHash,
                            rawPayloadKey,
                        },
                    });

                    pushedDoctors += 1;
                    log.info(`Đã lưu bác sĩ #${pushedDoctors}: ${normalized.fullName || rawName || url}`);
                }
            }
        }

        if (pushedDoctors < maxDoctorProfiles) {
            await enqueueLinks({
                globs: ['https://bookingcare.vn/**'],
                transformRequestFunction: (requestOptions) => {
                    const requestUrl = requestOptions.url || '';

                    if (!shouldEnqueueUrl(requestUrl)) return false;

                    const doctorId = extractDoctorIdFromUrl(requestUrl);
                    if (doctorId) {
                        requestOptions.uniqueKey = `${sourceSite}:${doctorId}`;
                    }
                    return requestOptions;
                },
            });
        }
    },

    async failedRequestHandler({ request }) {
        log.warning(`Request thất bại: ${request.url}`);
    },
});

await crawler.run(seedUrls);

const { items } = await Actor.openDataset().then((dataset) => dataset.getData());
const dataJsonPath = join(process.cwd(), 'data.json');
await writeFile(dataJsonPath, JSON.stringify(items, null, 2), 'utf8');
log.info(`Đã ghi ${items.length} bản ghi vào ${dataJsonPath}`);

await Actor.exit();