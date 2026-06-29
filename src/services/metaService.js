const getMetaErrorMessage = (stage, response, data) => {
  const error = data?.error || {};
  const details = [
    `${stage} failed`,
    `status=${response.status}`,
    error.message ? `message="${error.message}"` : null,
    error.type ? `type=${error.type}` : null,
    error.code ? `code=${error.code}` : null,
    error.error_subcode ? `subcode=${error.error_subcode}` : null,
    error.fbtrace_id ? `fbtrace_id=${error.fbtrace_id}` : null,
  ].filter(Boolean);

  return details.join(' | ');
};

const logInstagramRequest = (stage, context) => {

};

const waitForInstagramContainer = async ({ baseUrl, containerId, accessToken, authProvider }) => {
  const pollFields = authProvider === 'instagram' ? 'status_code' : 'status_code,error_info';
  const pollUrl = `${baseUrl}/${containerId}?fields=${pollFields}&access_token=${accessToken}`;
  const maxAttempts = 30;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;
    await new Promise(resolve => setTimeout(resolve, 5000));

    const pollRes = await fetch(pollUrl);
    const pollData = await pollRes.json();

    if (!pollRes.ok) {
      const message = getMetaErrorMessage('Instagram container polling', pollRes, pollData);
      console.error('❌ Instagram Container Poll Failed:', {
        status: pollRes.status,
        url: pollUrl.replace(accessToken, '[redacted]'),
        response: pollData,
      });
      throw new Error(message);
    }

    const statusCode = pollData.status_code;
    if (statusCode === 'FINISHED') return;
    if (statusCode === 'ERROR') {
      console.error('❌ Instagram Container Processing Error:', pollData.error_info);
      throw new Error(`Instagram media container processing failed: ${JSON.stringify(pollData.error_info || pollData)}`);
    }
  }

  throw new Error('Timeout waiting for Instagram media container to finish processing');
};

const publishInstagramContainer = async ({ baseUrl, accessToken, instagramBusinessAccountId, creationId, context = {} }) => {
  const publishUrl = `${baseUrl}/${instagramBusinessAccountId}/media_publish`;
  const publishParams = new URLSearchParams();
  publishParams.append('creation_id', creationId);
  publishParams.append('access_token', accessToken);

  const publishRes = await fetch(publishUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: publishParams
  });

  const publishData = await publishRes.json();

  if (!publishRes.ok || !publishData.id) {
    const message = getMetaErrorMessage('Instagram media publish', publishRes, publishData);
    console.error('❌ Instagram Publishing Failed:', {
      status: publishRes.status,
      url: publishUrl,
      accountId: instagramBusinessAccountId,
      response: publishData,
      ...context,
    });
    throw new Error(message);
  }

  return publishData.id;
};

const fetchInstagramMediaDetails = async ({ baseUrl, accessToken, mediaId }) => {
  const fields = 'id,media_type,media_product_type,permalink,children{id,media_type}';
  const url = `${baseUrl}/${mediaId}?fields=${fields}&access_token=${encodeURIComponent(accessToken)}`;
  const response = await fetch(url);
  const data = await response.json();

  return { response, data, url };
};

const fetchInstagramAccountMediaDetails = async ({ baseUrl, accessToken, instagramBusinessAccountId, mediaId }) => {
  const fields = 'id,media_type,media_product_type,permalink,children{id,media_type}';
  const url = `${baseUrl}/${instagramBusinessAccountId}/media?fields=${fields}&limit=50&access_token=${encodeURIComponent(accessToken)}`;
  const response = await fetch(url);
  const data = await response.json();
  const item = Array.isArray(data.data)
    ? data.data.find((media) => String(media.id) === String(mediaId))
    : null;

  return { response, data: item || data, url, found: Boolean(item) };
};

const assertPublishedCarouselDetails = ({ data, publishedId, expectedChildrenCount }) => {
  const childrenCount = Array.isArray(data.children?.data) ? data.children.data.length : 0;
  const isCarousel = data.media_type === 'CAROUSEL_ALBUM';
  const hasExpectedChildren = childrenCount === expectedChildrenCount;

  return {
    ok: isCarousel && hasExpectedChildren,
    childrenCount,
    message: [
      'Instagram carousel publish verification failed',
      `publishedId=${publishedId}`,
      `media_type=${data.media_type || 'unknown'}`,
      `children=${childrenCount}`,
      `expected=${expectedChildrenCount}`,
    ].join(' | '),
  };
};

const verifyPublishedInstagramCarousel = async ({
  baseUrl,
  accessToken,
  instagramBusinessAccountId,
  publishedId,
  expectedChildrenCount,
  graphHost,
  authProvider,
}) => {
  const maxAttempts = 6;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    const { response, data, url } = await fetchInstagramMediaDetails({
      baseUrl,
      accessToken,
      mediaId: publishedId,
    });

    if (!response.ok) {
      lastError = getMetaErrorMessage('Instagram carousel publish verification', response, data);
      console.error('❌ Instagram Carousel Verification Lookup Failed:', {
        attempt,
        status: response.status,
        url: url.replace(encodeURIComponent(accessToken), '[redacted]'),
        accountId: instagramBusinessAccountId,
        publishedId,
        graphHost,
        authProvider,
        response: data,
      });

      const feedLookup = await fetchInstagramAccountMediaDetails({
        baseUrl,
        accessToken,
        instagramBusinessAccountId,
        mediaId: publishedId,
      });

      if (feedLookup.response.ok && feedLookup.found) {
        const feedResult = assertPublishedCarouselDetails({
          data: feedLookup.data,
          publishedId,
          expectedChildrenCount,
        });

        if (feedResult.ok) {
          console.log('✅ Instagram carousel publish verified from account media feed:', {
            accountId: instagramBusinessAccountId,
            publishedId,
            childrenCount: feedResult.childrenCount,
            expectedChildrenCount,
            permalink: feedLookup.data.permalink,
          });
          return feedLookup.data;
        }

        lastError = feedResult.message;
        console.error('❌ Instagram Carousel Feed Verification Mismatch:', {
          attempt,
          accountId: instagramBusinessAccountId,
          publishedId,
          mediaType: feedLookup.data.media_type,
          mediaProductType: feedLookup.data.media_product_type,
          childrenCount: feedResult.childrenCount,
          expectedChildrenCount,
          permalink: feedLookup.data.permalink,
        });
      } else if (!feedLookup.response.ok) {
        console.error('❌ Instagram Carousel Feed Verification Lookup Failed:', {
          attempt,
          status: feedLookup.response.status,
          url: feedLookup.url.replace(encodeURIComponent(accessToken), '[redacted]'),
          accountId: instagramBusinessAccountId,
          publishedId,
          response: feedLookup.data,
        });
      }

      continue;
    }

    const result = assertPublishedCarouselDetails({ data, publishedId, expectedChildrenCount });

    if (result.ok) {
      console.log('✅ Instagram carousel publish verified:', {
        accountId: instagramBusinessAccountId,
        publishedId,
        childrenCount: result.childrenCount,
        expectedChildrenCount,
        permalink: data.permalink,
      });
      return data;
    }

    lastError = result.message;

    console.error('❌ Instagram Carousel Verification Mismatch:', {
      attempt,
      accountId: instagramBusinessAccountId,
      publishedId,
      mediaType: data.media_type,
      mediaProductType: data.media_product_type,
      childrenCount: result.childrenCount,
      expectedChildrenCount,
      permalink: data.permalink,
    });

    const feedLookup = await fetchInstagramAccountMediaDetails({
      baseUrl,
      accessToken,
      instagramBusinessAccountId,
      mediaId: publishedId,
    });

    if (feedLookup.response.ok && feedLookup.found) {
      const feedResult = assertPublishedCarouselDetails({
        data: feedLookup.data,
        publishedId,
        expectedChildrenCount,
      });

      if (feedResult.ok) {
        console.log('✅ Instagram carousel publish verified from account media feed:', {
          accountId: instagramBusinessAccountId,
          publishedId,
          childrenCount: feedResult.childrenCount,
          expectedChildrenCount,
          permalink: feedLookup.data.permalink,
        });
        return feedLookup.data;
      }

      lastError = feedResult.message;
      console.error('❌ Instagram Carousel Feed Verification Mismatch:', {
        attempt,
        accountId: instagramBusinessAccountId,
        publishedId,
        mediaType: feedLookup.data.media_type,
        mediaProductType: feedLookup.data.media_product_type,
        childrenCount: feedResult.childrenCount,
        expectedChildrenCount,
        permalink: feedLookup.data.permalink,
      });
    } else if (!feedLookup.response.ok) {
      console.error('❌ Instagram Carousel Feed Verification Lookup Failed:', {
        attempt,
        status: feedLookup.response.status,
        url: feedLookup.url.replace(encodeURIComponent(accessToken), '[redacted]'),
        accountId: instagramBusinessAccountId,
        publishedId,
        response: feedLookup.data,
      });
    }
  }

  throw new Error(lastError || 'Instagram carousel publish verification failed.');
};

/**
 * Publishes a post to Instagram (Reels or Image Feed Posts)
 * @param {string} accessToken - Instagram/Facebook access token
 * @param {string} instagramBusinessAccountId - Target Instagram Business Account ID
 * @param {string} mediaUrl - Public url of the media file (e.g. from Cloudflare R2)
 * @param {string} mediaType - 'image' or 'video'
 * @param {string} caption - Post caption
 * @param {string} authProvider - 'facebook' for Page-linked tokens, 'instagram' for direct Instagram Login tokens
 * @returns {Promise<string>} - Published Meta Media ID
 */
export const publishToInstagram = async (accessToken, instagramBusinessAccountId, mediaUrl, mediaType, caption, authProvider = 'facebook') => {
  const isVideo = mediaType === 'video';
  const apiVersion = 'v20.0';
  const graphHost = authProvider === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com';
  const baseUrl = `https://${graphHost}/${apiVersion}`;

  logInstagramRequest('container-create', {
    graphHost,
    accountId: instagramBusinessAccountId,
    authProvider,
    mediaType,
    mediaUrl,
    captionLength: caption?.length || 0,
    accessToken,
  });
  
  // Step 1: Create the media container
  const containerUrl = `${baseUrl}/${instagramBusinessAccountId}/media`;
  const containerParams = new URLSearchParams();
  containerParams.append('caption', caption || '');
  containerParams.append('access_token', accessToken);

  if (isVideo) {
    containerParams.append('media_type', 'REELS');
    containerParams.append('video_url', mediaUrl);
    containerParams.append('share_to_feed', 'true');
  } else {
    containerParams.append('image_url', mediaUrl);
  }

  const containerRes = await fetch(containerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: containerParams
  });

  const containerData = await containerRes.json();

  if (!containerRes.ok || !containerData.id) {
    const message = getMetaErrorMessage('Instagram media container creation', containerRes, containerData);
    console.error('❌ Instagram Media Container Creation Failed:', {
      status: containerRes.status,
      url: containerUrl,
      graphHost,
      accountId: instagramBusinessAccountId,
      authProvider,
      mediaType,
      mediaUrl,
      response: containerData,
    });
    throw new Error(message);
  }

  const containerId = containerData.id;

  // Step 2: Poll status of the container (required for video/reels, good practice for images)
  await waitForInstagramContainer({ baseUrl, containerId, accessToken, authProvider });

  logInstagramRequest('media-publish', {
    graphHost,
    accountId: instagramBusinessAccountId,
    authProvider,
    mediaType,
    mediaUrl,
    captionLength: caption?.length || 0,
    accessToken,
  });

  // Step 3: Publish the container
  return publishInstagramContainer({
    baseUrl,
    accessToken,
    instagramBusinessAccountId,
    creationId: containerId,
    context: { graphHost, authProvider, mediaType },
  });
};

export const publishCarouselToInstagram = async (accessToken, instagramBusinessAccountId, mediaFiles = [], caption, authProvider = 'facebook') => {
  const apiVersion = 'v20.0';
  const graphHost = authProvider === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com';
  const baseUrl = `https://${graphHost}/${apiVersion}`;
  const containerUrl = `${baseUrl}/${instagramBusinessAccountId}/media`;

  console.log(`📸 [publishCarouselToInstagram] Starting carousel publishing. Total slides: ${mediaFiles.length}`);

  if (!Array.isArray(mediaFiles) || mediaFiles.length < 2) {
    throw new Error('Instagram carousel publishing requires at least two media files.');
  }
  if (mediaFiles.length > 10) {
    throw new Error('Instagram carousel publishing supports up to 10 media files.');
  }

  const childContainerIds = [];

  for (let idx = 0; idx < mediaFiles.length; idx++) {
    const media = mediaFiles[idx];
    const isVideo = media.type === 'video';
    const childParams = new URLSearchParams();
    childParams.append('is_carousel_item', 'true');
    childParams.append('access_token', accessToken);
    if (isVideo) {
      childParams.append('media_type', 'VIDEO');
      childParams.append('video_url', media.url);
    } else {
      childParams.append('image_url', media.url);
    }

    console.log(`⏳ [publishCarouselToInstagram] Creating container for Slide ${idx + 1}/${mediaFiles.length}: Name="${media.name}", URL="${media.url}"`);

    const childRes = await fetch(containerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: childParams,
    });
    const childData = await childRes.json();
    if (!childRes.ok || !childData.id) {
      const message = getMetaErrorMessage('Instagram carousel child container creation', childRes, childData);
      console.error('❌ Instagram Carousel Child Container Creation Failed:', {
        status: childRes.status,
        url: containerUrl,
        graphHost,
        accountId: instagramBusinessAccountId,
        authProvider,
        mediaType: media.type,
        mediaUrl: media.url,
        response: childData,
      });
      throw new Error(message);
    }

    console.log(`✅ [publishCarouselToInstagram] Slide ${idx + 1} container created with ID: ${childData.id}. Polling status...`);

    await waitForInstagramContainer({
      baseUrl,
      containerId: childData.id,
      accessToken,
      authProvider,
    });
    
    console.log(`🎉 [publishCarouselToInstagram] Slide ${idx + 1} processed successfully.`);
    childContainerIds.push(childData.id);
  }

  console.log(`🔗 [publishCarouselToInstagram] All slides processed. Container IDs:`, childContainerIds);

  const carouselParams = new URLSearchParams();
  carouselParams.append('media_type', 'CAROUSEL');
  carouselParams.append('children', childContainerIds.join(','));
  carouselParams.append('caption', caption || '');
  carouselParams.append('access_token', accessToken);

  const carouselRes = await fetch(containerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: carouselParams,
  });
  const carouselData = await carouselRes.json();
  if (!carouselRes.ok || !carouselData.id) {
    const message = getMetaErrorMessage('Instagram carousel parent container creation', carouselRes, carouselData);
    console.error('❌ Instagram Carousel Parent Container Creation Failed:', {
      status: carouselRes.status,
      url: containerUrl,
      graphHost,
      accountId: instagramBusinessAccountId,
      authProvider,
      childrenCount: childContainerIds.length,
      response: carouselData,
    });
    throw new Error(message);
  }

  console.log(`✅ [publishCarouselToInstagram] Parent container created with ID: ${carouselData.id}. Polling parent container...`);

  await waitForInstagramContainer({
    baseUrl,
    containerId: carouselData.id,
    accessToken,
    authProvider,
  });

  const publishedId = await publishInstagramContainer({
    baseUrl,
    accessToken,
    instagramBusinessAccountId,
    creationId: carouselData.id,
    context: { graphHost, authProvider, mediaType: 'carousel' },
  });

  await verifyPublishedInstagramCarousel({
    baseUrl,
    accessToken,
    instagramBusinessAccountId,
    publishedId,
    expectedChildrenCount: mediaFiles.length,
    graphHost,
    authProvider,
  });

  return publishedId;
};

/**
 * Publishes a post to Facebook Page (Feed or Video posts)
 * @param {string} accessToken - Facebook Page Access Token
 * @param {string} pageId - Target Facebook Page ID
 * @param {string} mediaUrl - Public url of the media file (optional)
 * @param {string} mediaType - 'image' or 'video' (optional)
 * @param {string} caption - Post message
 * @returns {Promise<string>} - Published Facebook post ID
 */
export const publishToFacebook = async (accessToken, pageId, mediaUrl, mediaType, caption) => {
  const apiVersion = 'v20.0';
  const baseUrl = `https://graph.facebook.com/${apiVersion}`;


  let publishUrl = `${baseUrl}/${pageId}/feed`;
  let params = {
    message: caption || '',
    access_token: accessToken,
  };

  if (mediaUrl) {
    if (mediaType === 'video') {
      // Publish to Page Video Feed
      publishUrl = `${baseUrl}/${pageId}/videos`;
      params = {
        description: caption || '',
        file_url: mediaUrl,
        access_token: accessToken,
      };
    } else {
      // Publish to Page Photos
      publishUrl = `${baseUrl}/${pageId}/photos`;
      params = {
        message: caption || '',
        url: mediaUrl,
        access_token: accessToken,
      };
    }
  }

  const response = await fetch(publishUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });

  const data = await response.json();

  if (!response.ok || (!data.id && !data.post_id)) {
    console.error('❌ Facebook Publishing Failed:', data);
    throw new Error(data.error?.message || 'Failed to publish to Facebook Page');
  }

  const publishedId = data.post_id || data.id;
  return publishedId;
};
