import { applyDecorators } from '@nestjs/common';
import { ArrayMaxSize, ArrayUnique, IsArray, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** Enough to show a bus or a hotel from every side; past it the app's gallery only gets slower to swipe through. */
export const MAX_GALLERY_IMAGES = 10;

/**
 * A photo uploaded through POST /trips/images, which is all the admin panel sends, or a full web address: a bus's single
 * photo from before galleries is carried over as it was, and saving the bus again must not refuse it.
 */
// Ids are the database's own and not always UUIDs, so any short run of URL-safe characters.
const GALLERY_URL = /^(\/trips\/images\/[A-Za-z0-9_-]{8,64}|https?:\/\/[^\s]+)$/;

/** A bus's or a hotel's photos in the order customers see them, the first being the cover. */
export const GalleryImages = () =>
  applyDecorators(
    IsOptional(),
    IsArray(),
    ArrayMaxSize(MAX_GALLERY_IMAGES, { message: `الحد الأقصى ${MAX_GALLERY_IMAGES} صور` }),
    ArrayUnique({ message: 'الصورة مكررة' }),
    IsString({ each: true }),
    MaxLength(500, { each: true }),
    Matches(GALLERY_URL, { each: true, message: 'الصورة غير صالحة' }),
  );

/** Only the URLs, in order: ids and dates mean nothing to a client, which replaces the whole list when it saves. */
export const GALLERY_SELECT = { orderBy: { sortOrder: 'asc' }, select: { url: true } } as const;

/** Rows for a gallery saved in the order it was sent. */
export const galleryRows = (urls: string[]) => urls.map((url, sortOrder) => ({ url, sortOrder }));
