import React, { useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';

export function RenderMarkdown( {markdownText} ) {
  const markdownRef = useRef(null);

  useEffect(() => {
    const handleCopy = (event) => {
      // Prevent the default copy action
      event.preventDefault();
      
      // Modify clipboard data if necessary
      // For example, replace the copied text with an empty string
      event.clipboardData.setData('text/plain', '');
    };

    const markdownDiv = markdownRef.current;
    if (markdownDiv) {
      markdownDiv.addEventListener('copy', handleCopy);
    }

    // Clean up the event listener on component unmount
    return () => {
      if (markdownDiv) {
        markdownDiv.removeEventListener('copy', handleCopy);
      }
    };
  }, []);

  return (
    <div ref={markdownRef} className='w-100%'>
      <ReactMarkdown className='prose no-copy !max-w-none pb-5'>{markdownText}</ReactMarkdown>
    </div>
  );
};