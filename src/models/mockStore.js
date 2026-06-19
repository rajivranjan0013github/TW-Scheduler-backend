// In-Memory Data Store for Sandbox / Demo Mode

export const mockStore = {
  users: [
    {
      _id: 'u1',
      name: 'Sarah Jenkins (Owner)',
      email: 'owner@twcreators.com',
      avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150',
      role: 'owner',
      googleId: 'g1',
      createdAt: new Date(),
    },
    {
      _id: 'u2',
      name: 'Alex Rivera (Admin)',
      email: 'admin@twcreators.com',
      avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150',
      role: 'owner',
      googleId: 'g2',
      createdAt: new Date(),
    },
    {
      _id: 'u3',
      name: 'Marcus Chen (Editor)',
      email: 'editor@twcreators.com',
      avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150',
      role: 'owner',
      googleId: 'g3',
      createdAt: new Date(),
    },
    {
      _id: 'u4',
      name: 'Elena Rostova (Viewer)',
      email: 'viewer@twcreators.com',
      avatar: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150',
      role: 'owner',
      googleId: 'g4',
      createdAt: new Date(),
    }
  ],
  socialAccounts: [
    {
      _id: 'sa1',
      platform: 'instagram',
      accountId: 'ig_travel_diaries',
      name: 'Travel Diaries',
      username: 'travel_diaries_official',
      avatarUrl: 'https://images.unsplash.com/photo-1488646953014-85cb44e25828?w=150',
      isConnected: true,
      createdAt: new Date(),
    },
    {
      _id: 'sa2',
      platform: 'instagram',
      accountId: 'ig_tech_reviews',
      name: 'Tech Reviews',
      username: 'techreviews_daily',
      avatarUrl: 'https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=150',
      isConnected: true,
      createdAt: new Date(),
    },
    {
      _id: 'sa3',
      platform: 'facebook',
      accountId: 'fb_page_travel',
      name: 'Travel Diaries FB Page',
      username: 'traveldiariesfb',
      avatarUrl: 'https://images.unsplash.com/photo-1488646953014-85cb44e25828?w=150',
      isConnected: true,
      createdAt: new Date(),
    },
    {
      _id: 'sa4',
      platform: 'facebook',
      accountId: 'fb_page_tech',
      name: 'Tech Reviews Community',
      username: 'techreviewsfb',
      avatarUrl: 'https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=150',
      isConnected: true,
      createdAt: new Date(),
    }
  ],
  folders: [
    { _id: 'f1', name: 'Summer Reels', parentFolderId: null, createdAt: new Date() },
    { _id: 'f2', name: 'Product Launches', parentFolderId: null, createdAt: new Date() },
    { _id: 'f3', name: 'Behind The Scenes', parentFolderId: null, createdAt: new Date() }
  ],
  media: [
    {
      _id: 'm1',
      folderId: 'f1',
      name: 'Beach Sunset.mp4',
      type: 'video',
      url: 'https://assets.mixkit.co/videos/preview/mixkit-waves-breaking-in-the-sunset-1527-large.mp4',
      storageKey: 'sunset-mock',
      caption: 'Chasing sunsets and waves. #summer #travel #wanderlust',
      tags: ['summer', 'travel', 'reels'],
      size: 4850020,
      createdAt: new Date(Date.now() - 3600000 * 24 * 2),
    },
    {
      _id: 'm2',
      folderId: 'f1',
      name: 'Surfing Action.mp4',
      type: 'video',
      url: 'https://assets.mixkit.co/videos/preview/mixkit-surfer-riding-a-wave-under-a-clear-sky-4422-large.mp4',
      storageKey: 'surfing-mock',
      caption: 'Riding the morning tide. #surfing #reels',
      tags: ['summer', 'sports', 'reels'],
      size: 8900400,
      createdAt: new Date(Date.now() - 3600000 * 24),
    },
    {
      _id: 'm3',
      folderId: 'f2',
      name: 'iPhone 16 Mockup.png',
      type: 'image',
      url: 'https://images.unsplash.com/photo-1510557880182-3d4d3cba35a5?w=600',
      storageKey: 'iphone-mock',
      caption: 'A clean product mockup for the next launch.',
      tags: ['tech', 'product', 'mockup'],
      size: 1540300,
      createdAt: new Date(Date.now() - 3600000 * 6),
    },
    {
      _id: 'm4',
      folderId: null,
      name: 'Office Coffee.png',
      type: 'image',
      url: 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=600',
      storageKey: 'coffee-mock',
      caption: 'Office coffee before the day starts.',
      tags: ['lifestyle', 'coffee'],
      size: 2100500,
      createdAt: new Date(),
    }
  ],
  scheduledPosts: [],
  comments: [
    {
      _id: 'c1',
      accountId: 'ig_travel_diaries',
      postId: 'p1_post',
      commentId: 'comm_1',
      text: 'Oh wow! Where is this beach exactly? Stunning sunset!',
      username: 'nomad_adventurer',
      timestamp: new Date(Date.now() - 3600000 * 2),
      isReplied: false,
      replies: []
    },
    {
      _id: 'c2',
      accountId: 'ig_tech_reviews',
      postId: 'p2_post',
      commentId: 'comm_2',
      text: 'Is the battery life really that good? Thinking of upgrading.',
      username: 'gadget_guru',
      timestamp: new Date(Date.now() - 3600000 * 5),
      isReplied: true,
      replies: [
        {
          text: 'Yes! It easily lasts a full day of heavy use.',
          username: 'techreviews_daily',
          timestamp: new Date(Date.now() - 3600000 * 4.5)
        }
      ]
    }
  ]
};

// Seed initial scheduled posts
const baseDate = new Date();
baseDate.setMinutes(0, 0, 0);

mockStore.scheduledPosts = [
  {
    _id: 'sp1',
    socialAccountIds: ['sa1', 'sa3'],
    mediaIds: ['m1'],
    caption: 'Chasing sunsets and waves 🌅🌊 #summer #travel #wanderlust',
    scheduledAt: new Date(baseDate.getTime() + 3600000 * 2), // 2 hours from now
    status: 'scheduled',
    platformSpecifics: { type: 'reels' },
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: 'sp2',
    socialAccountIds: ['sa2'],
    mediaIds: ['m3'],
    caption: 'Testing the new camera configurations. Mind-blown! 📸🤯',
    scheduledAt: new Date(baseDate.getTime() + 3600000 * 24), // 24 hours from now
    status: 'scheduled',
    platformSpecifics: { type: 'post' },
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: 'sp3',
    socialAccountIds: ['sa1'],
    mediaIds: ['m2'],
    caption: 'Riding the morning tide 🏄‍♂️✨',
    scheduledAt: new Date(baseDate.getTime() - 3600000 * 5), // 5 hours ago
    status: 'published',
    platformSpecifics: { type: 'reels' },
    createdAt: new Date(),
    updatedAt: new Date(),
  }
];
