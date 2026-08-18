import Folder from '../models/Folder.js';
import Campaign from '../models/Campaign.js';

export const DEFAULT_CAMPAIGN_FOLDERS = [
  {
    name: 'Hooks',
    tags: ['hooks'],
  },
  {
    name: 'App Showcase',
    tags: ['app-showcase', 'promo'],
    isPromoDefault: true,
  },
  {
    name: 'Generated',
    tags: ['generated', 'schedule'],
  },
];

const escapeRegex = (string) => string.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');

/**
 * Ensures a campaign has the required standard folders:
 * 1. "Hooks"
 * 2. "App Showcase"
 * 3. "Generated"
 * 4. "Audio" (with "Trending songs" & "My own audios" subfolders)
 *
 * @param {string|import('mongoose').Types.ObjectId} campaignId
 * @param {string|import('mongoose').Types.ObjectId} [userId]
 * @param {Object} [options]
 * @param {string|null} [options.promoFolderId]
 * @returns {Promise<Object|null>} Map of folder name -> Folder document
 */
export const ensureDefaultCampaignFolders = async (campaignId, userId = null, options = {}) => {
  if (!campaignId) return null;

  try {
    const campaign = await Campaign.findById(campaignId);
    if (!campaign) return null;

    const effectiveUserId = userId || campaign.createdBy;
    if (!effectiveUserId) return null;

    // Find existing root-level folders for this campaign
    const existingFolders = await Folder.find({
      campaignId: campaign._id,
      scope: 'campaign',
      parentFolderId: null,
    });

    const folderMap = {};

    for (const def of DEFAULT_CAMPAIGN_FOLDERS) {
      const regex = new RegExp(`^${escapeRegex(def.name)}$`, 'i');
      let folder = existingFolders.find((f) => regex.test(f.name));

      if (!folder) {
        folder = await Folder.create({
          userId: effectiveUserId,
          campaignId: campaign._id,
          scope: 'campaign',
          name: def.name,
          parentFolderId: null,
          kind: 'folder',
          tags: def.tags || [],
        });
      }

      folderMap[def.name] = folder;

      // Provision defined subfolders if any
      if (Array.isArray(def.subfolders) && def.subfolders.length > 0) {
        const existingSubfolders = await Folder.find({
          campaignId: campaign._id,
          parentFolderId: folder._id,
        });

        for (const subDef of def.subfolders) {
          const subRegex = new RegExp(`^${escapeRegex(subDef.name)}$`, 'i');
          let subfolder = existingSubfolders.find((sf) => subRegex.test(sf.name));

          if (!subfolder) {
            subfolder = await Folder.create({
              userId: effectiveUserId,
              campaignId: campaign._id,
              scope: folder.scope || 'campaign',
              name: subDef.name,
              parentFolderId: folder._id,
              kind: 'folder',
              tags: subDef.tags || [],
            });
          }
        }
      }
    }

    // If campaign has no promoFolderId assigned, point it to App Showcase
    if (!campaign.promoFolderId && folderMap['App Showcase']) {
      campaign.promoFolderId = folderMap['App Showcase']._id;
      await campaign.save();
    }

    return folderMap;
  } catch (error) {
    console.error(`[campaignFolderService] Error ensuring default folders for campaign ${campaignId}:`, error.message);
    return null;
  }
};
