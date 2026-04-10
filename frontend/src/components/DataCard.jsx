import { Skeleton } from 'boneyard-js/react';

const placeholderData = {
  avatar: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  title: 'Sample profile title',
  description: 'Primary description text for the card.',
  meta: 'Secondary description text for the card.'
};

function DataCardContent({ data }) {
  return (
    <article className="data-card">
      <img className="data-card-avatar" src={data.avatar} alt="" />
      <div className="data-card-copy">
        <h2>{data.title}</h2>
        <p>{data.description}</p>
        <p>{data.meta}</p>
      </div>
    </article>
  );
}

function DataCard({ isLoading, data }) {
  const cardData = data || placeholderData;

  return (
    <Skeleton
      name="data-card-profile"
      loading={isLoading}
      animate="shimmer"
      transition
      fixture={<DataCardContent data={placeholderData} />}
    >
      <DataCardContent data={cardData} />
    </Skeleton>
  );
}

export default DataCard;

