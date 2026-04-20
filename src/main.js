import { createHash } from 'node:crypto';
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

const extractDoctorIdFromUrl = (url = '') => {
    const match = url.match(/-i(\d+)(?:[/?#]|$)/i);
    if (match) return match[1];
    const fallback = url.match(/i(\d+)(?:[/?#]|$)/i);
    return fallback ? fallback[1] : null;
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

const extractScheduleDate = ($) => {
    const dateText = $('body')
        .find('*')
        .map((_, el) => normalizeWhitespace($(el).text()))
        .get()
        .find((text) => /(thứ\s*[2-8]|chủ nhật)\s*-\s*\d{1,2}\/\d{1,2}(\/\d{2,4})?/i.test(text));

    if (!dateText) return null;

    const match = dateText.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (!match) return null;

    const now = new Date();
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = match[3] ? Number(match[3].length === 2 ? `20${match[3]}` : match[3]) : now.getFullYear();

    const isoDate = new Date(Date.UTC(year, month - 1, day));
    if (Number.isNaN(isoDate.getTime())) return null;
    return isoDate.toISOString().slice(0, 10);
};

const extractSlots = ($) => {
    const slotRegex = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/;
    const slotDate = extractScheduleDate($);

    const slots = $('body')
        .find('*')
        .map((_, el) => normalizeWhitespace($(el).text()))
        .get()
        .filter((text) => slotRegex.test(text))
        .map((text) => {
            const [, startAt, endAt] = text.match(slotRegex) || [];
            return {
                date: slotDate,
                startAt,
                endAt,
                maxBookings: null,
                source: 'crawl',
            };
        });

    const unique = new Map();
    for (const slot of slots) {
        unique.set(`${slot.date ?? 'unknown'}|${slot.startAt}|${slot.endAt}`, slot);
    }
    return [...unique.values()];
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

const toStartUrls = (value) => {
    if (!Array.isArray(value)) return [{ url: 'https://bookingcare.vn/' }];
    return value
        .map((item) => (typeof item === 'string' ? { url: item } : item))
        .filter((item) => item?.url);
};

const seedUrls = toStartUrls(startUrls);

log.info(`Start URLs: ${seedUrls.map((item) => item.url).join(', ')}`);
log.info(`maxRequestsPerCrawl=${maxRequestsPerCrawl}, maxDoctorProfiles=${maxDoctorProfiles}`);

const crawler = new CheerioCrawler({
    maxRequestsPerCrawl,

    async requestHandler({ request, $, enqueueLinks }) {
        const url = request.loadedUrl || request.url;
        const isDoctorPage = /bookingcare\.vn\/.+-i\d+/i.test(url);

        log.info(`Đang xử lý: ${url} (doctorPage=${isDoctorPage})`);

        if (isDoctorPage && pushedDoctors < maxDoctorProfiles) {
            const doctorHeader = normalizeWhitespace($('h1').first().text());
            const { professionalTitle, fullName } = splitProfessionalTitle(doctorHeader);
            const bodyText = normalizeWhitespace($('body').text());
            const yearsOfExperience = parseYearsOfExperience(bodyText);

            const specialtyTexts = [
                ...$('a[href*="/kham-chuyen-khoa/"]')
                    .map((_, el) => normalizeWhitespace($(el).text()))
                    .get(),
                ...$('nav a')
                    .map((_, el) => normalizeWhitespace($(el).text()))
                    .get()
                    .filter((text) => /[a-zA-ZÀ-ỹ]/.test(text) && !/^(trang chủ|khám chuyên khoa)$/i.test(text)),
            ]
                .filter(Boolean)
                .filter((value, index, all) => all.indexOf(value) === index);

            const specialties = specialtyTexts.map((name, index) => ({
                name,
                isPrimary: index === 0,
            }));

            const consultationFeeText = normalizeWhitespace(
                $('[data-testid="clinic-price"], [data-testid*="price"], div:contains("GIÁ KHÁM")')
                    .first()
                    .text(),
            );

            const scheduleTextCandidates = $('body')
                .find('*')
                .map((_, el) => normalizeWhitespace($(el).text()))
                .get()
                .filter((text) => /(thứ\s*[2-8]|chủ nhật).*(sáng|chiều|tối)/i.test(text));

            const slots = extractSlots($);
            const data = {
                sourceSite,
                sourceDoctorId: extractDoctorIdFromUrl(url),
                sourceUrl: url,
                crawledAt: new Date().toISOString(),
                rawHtmlHash: hashHtml($.html()),
                rawJson: extractRawJson($),
                fullName,
                professionalTitle,
                avatarUrl: absoluteUrl(
                    $('[data-testid="clinic-image"] img, img').first().attr('src')
                        || $('[data-testid="clinic-image"] img, img').first().attr('data-src')
                        || null,
                    url,
                ),
                bio: normalizeWhitespace(
                    $('meta[name="description"]').attr('content')
                        || $('h1')
                            .first()
                            .parent()
                            .find('p, div')
                            .map((_, el) => normalizeWhitespace($(el).text()))
                            .get()
                            .filter((text) => text.length > 20)
                            .slice(0, 3)
                            .join(' '),
                ) || null,
                yearsOfExperience,
                specialties,
                workplaceName: normalizeWhitespace(
                    $('[data-testid="clinic-name"], a[href*="/co-so-y-te/"]').first().text(),
                ) || null,
                workplaceAddressText: normalizeWhitespace(
                    $('[data-testid="clinic-address"]').first().text()
                        || $('div:contains("Toà nhà"), div:contains("Tòa nhà"), div:contains("Hà Nội"), div:contains("Hồ Chí Minh")')
                            .first()
                            .text(),
                ) || null,
                consultationFee: {
                    amount: moneyToNumber(consultationFeeText),
                    currency: consultationFeeText.includes('đ') ? 'VND' : null,
                    rawText: consultationFeeText || null,
                },
                education: collectListAfterHeading($, /quá trình đào tạo/i),
                certifications: collectListAfterHeading($, /chứng chỉ|chứng nhận/i),
                experiences: collectListAfterHeading($, /quá trình công tác/i),
                services: collectListAfterHeading($, /nhận khám và điều trị|dịch vụ/i),
                treatments: collectListAfterHeading($, /điều trị/i),
                languages: [],
                highlights: [],
                weeklyScheduleText: slots.length ? null : scheduleTextCandidates.join(' | ') || null,
                slots,
            };

            await Actor.pushData(data);
            pushedDoctors += 1;
            log.info(`Đã lưu bác sĩ #${pushedDoctors}: ${fullName || doctorHeader || url}`);
        }

        await enqueueLinks({
            globs: ['https://bookingcare.vn/**'],
            transformRequestFunction: (requestOptions) => {
                const requestUrl = requestOptions.url || '';
                const doctorId = extractDoctorIdFromUrl(requestUrl);
                if (doctorId) {
                    requestOptions.uniqueKey = `${sourceSite}:${doctorId}`;
                }
                return requestOptions;
            },
        });
    },

    async failedRequestHandler({ request }) {
        log.warning(`Request thất bại: ${request.url}`);
    },
});

await crawler.run(seedUrls);

await Actor.exit();